#!/usr/bin/env python3
#
# 港股期权「盘后报价存活曲线 + OI 定稿时刻」一次性取证探针 (071 P0)。
#
# 回答两个互相纠缠、只能同一次实验一起答的问题:
#   Q1 报价存活: 港股做市商盘后撤单 —— 库内 23:00 那一拍 bid 覆盖率只有 27% (us 79.7%),
#      而 08-17 盘中探针实测 96.3%。曲线决定离线档能不能靠「把采集时刻提前」救回来。
#   Q2 OI 定稿: 066 U2 只把定稿时刻夹在 16:30–21:30 之间, 保守取了上界写进
#      `market-session.rules.ts` 的 `MARKET_OI_SETTLE_LOCAL_MINUTE.hk = 21:30`。
#      若真值靠近 16:30, Q1 的「单拍前移」就成立; 若真到 21:30, 就只能两拍。
#
# 🚨 **采样窗蓄意在 22:45 收尾, 不采 23:00** —— 那一刻是生产的 `hk_option_daily_snapshot`
#    采集轮。限频桶是 **vendor 侧**的 (见 `services/futu-shim/src/futu_shim/app.py`
#    `/option-chain` 段: 绕过 shim 只绕开本地闸, vendor 那个真桶照撞), 撞上去会让生产轮吃
#    429。而 23:00 那个数据点**白捡**: 生产轮自己会把它写进 `option_daily_snapshot`, 直接查库。
#
# 🚨 **采集端全开**: 全链、无 filter、SDK 返什么就落什么 (含 greeks / OI / 净OI /
#    `option_owner_lot_multiplier` / `option_contract_nominal_value` —— 后两个是 071 P2
#    合约乘数的现成证据)。过滤一律放分析端 —— 采错了不可回补, 港股期权链无历史快照。
#
# 只读: 不下单、不写库、不碰 shim。直连本机 OpenD。
#
# Runs on the broker gateway host (代号 broker-hk; 需该机 venv 里有 futu SDK):
#   本机$ ssh "$NVY_BROKER_HK_SSH_ALIAS" 'mkdir -p ~/nvy-probe && cat > ~/nvy-probe/probe.py' \
#           < ops/bin/hk-option-post-close-probe.py
#   本机$ ssh "$NVY_BROKER_HK_SSH_ALIAS" \
#           'cd ~/nvy-probe && nohup /opt/futu-collector/venv/bin/python probe.py \
#              --codes HK.00700 --out ~/nvy-probe/hk-post-close.jsonl > run.log 2>&1 &'
#   收工$ ssh "$NVY_BROKER_HK_SSH_ALIAS" 'rm -rf ~/nvy-probe'     # 🚨 收尾必删, 见下
#
#   --smoke 立刻打一拍就退 (pilot 用, 不等网格)。先 smoke 再挂长跑。
#
# 🚨 **收尾清理 = 删 `~/nvy-probe` 整个目录**。刻意**不装 crontab** (066 T16 踩过「仓外
#    crontab 忘删」): 本脚本自己 sleep 到点、跑完最后一格自然退出, 没有需要摘的调度器。
#
# 退出码: 0 = 网格跑完; 1 = 启动期就失败 (连不上 OpenD / 链发现零结果)。
#         网格内单拍失败**不中断** —— 落一行 kind=error 继续, 少一格远好过整条曲线没了。

from __future__ import annotations

import argparse
import json
import sys
import time
from datetime import datetime

# 默认网格 (宿主机当地时间, = HKT)。**按信息密度分布, 不平均撒**:
# · 15:55–16:20 每 5 分钟 —— 收盘 (16:00) + CAS 结束 (16:10) 前后, 撤单就发生在这一段;
# · 16:30–21:00 稀疏 —— OI 定稿区间的主体, 只需看「变没变」;
# · 21:00–22:00 加密 —— 066 给的定稿上界 21:30 就在这里, 要能把它收窄;
# · 22:45 收尾 —— 生产轮 23:00 之前的最后一格 (见文件头那条 🚨)。
DEFAULT_GRID = (
    "15:55,16:00,16:05,16:10,16:15,16:20,16:30,16:45,17:00,17:30,"
    "18:00,19:00,20:00,20:30,21:00,21:15,21:30,21:45,22:00,22:45"
)

# vendor 限频 (`futu_shim/ratelimit.py` 的 LIMITS): snapshot 60/30s, option_chain 10/30s。
# 取远比下限保守的间隔 —— 探针跟生产共用 vendor 桶, 省这几秒没有任何价值。
SNAPSHOT_PACE_S = 3.5
CHAIN_PACE_S = 3.5

# 官方单批上限 (同 `futu_shim/app.py` 的 SNAPSHOT_MAX_CODES)。
SNAPSHOT_MAX_CODES = 400


def log(msg: str) -> None:
    print(f"[{datetime.now().isoformat(timespec='seconds')}] {msg}", flush=True)


def emit(fh, kind: str, tick: str, payload: dict) -> None:
    """一行一条, 原样落盘。`default=str` 兜住 Timestamp / Decimal 这类非 JSON 原生类型。"""
    fh.write(json.dumps({"tick": tick, "kind": kind, **payload}, default=str, ensure_ascii=False))
    fh.write("\n")
    fh.flush()  # 长跑 7 小时, 不 flush 等于把证据押在进程善终上


def unwrap(ret, content, what: str):
    """futu SDK 恒返 (ret, content); ret != RET_OK 时 content 是错误字符串。"""
    from futu import RET_OK

    if ret != RET_OK:
        raise RuntimeError(f"{what} failed: {content}")
    return content


def discover_contracts(ctx, code: str, fh) -> list[str]:
    """全链发现: 到期日列表 → 逐到期日拉链。复杂度 O(E) 次 vendor 调用 (E = 到期日数, hk ≈ 8)。

    逐到期日单独拉 (start=end=d) 而不是拉一个宽窗 —— 窗跨度有 vendor 上限, 逐日调用数一样、
    形状更简单, 且哪个到期日拉失败一目了然。
    """
    dates = unwrap(*ctx.get_option_expiration_date(code), what=f"expiration_date({code})")
    day_list = [str(d) for d in dates["strike_time"].tolist()]
    log(f"{code}: {len(day_list)} 个到期日 {day_list}")

    contracts: list[str] = []
    for d in day_list:
        time.sleep(CHAIN_PACE_S)
        frame = unwrap(*ctx.get_option_chain(code, start=d, end=d), what=f"chain({code},{d})")
        rows = frame.to_dict("records")
        for row in rows:
            emit(fh, "chain", "discovery", {"underlying": code, "row": row})
            contracts.append(row["code"])
        log(f"{code} {d}: {len(rows)} 条合约")
    return contracts


def open_ctx(host: str, port: int):
    """每拍新开一条 OpenD 连接 —— 蓄意不复用。

    进程可能在开盘前十几个小时就挂起等第一格, 而 `OpenQuoteContext` 是长连接: 握着它空转
    7–17 小时, 断了不会告诉你, 只会在某一拍集体失败。OpenD 就在本机, 建连成本可以忽略,
    拿它换掉整类「连接悄悄死掉」的故障是白赚。
    """
    from futu import OpenQuoteContext

    return OpenQuoteContext(host=host, port=port)


def snapshot_tick(ctx, tick: str, codes: list[str], fh) -> None:
    """一拍: 全部合约码分批 snapshot。复杂度 O(C/400) 次 vendor 调用。

    单批失败落 error 行继续 —— 一批 400 条挂掉不该让同一拍的其余批陪葬。
    """
    ok = 0
    for i in range(0, len(codes), SNAPSHOT_MAX_CODES):
        batch = codes[i : i + SNAPSHOT_MAX_CODES]
        time.sleep(SNAPSHOT_PACE_S)
        try:
            frame = unwrap(*ctx.get_market_snapshot(batch), what=f"snapshot[{i}:{i+len(batch)}]")
        except Exception as exc:  # noqa: BLE001 —— 探针要的是「继续」, 不是精确分类
            emit(fh, "error", tick, {"batch_from": i, "size": len(batch), "error": str(exc)})
            log(f"{tick} 批 {i} 失败: {exc}")
            continue
        for row in frame.to_dict("records"):
            emit(fh, "snapshot", tick, {"row": row})
            ok += 1
    log(f"{tick}: 落 {ok} 行")


def state_tick(ctx, tick: str, fh) -> None:
    """一发 `get_global_state()`，payload 整块原样落。复杂度 O(1) 次 vendor 调用。

    这条服务的是另一个问题: **港股午休时 vendor 报的市场状态字面量到底是什么**。
    `market-session.rules.ts:68-75` 把 hk 合成单段 `[09:30,16:00]`（午休蓄意不建模），
    而 071 实时档的闸读的是 vendor 状态、不读本地表 —— 「午休天然被挡」目前是**推断**。
    白名单判断归消费端, 所以这里不做任何语义归一, 原样落。
    """
    from futu import RET_OK

    ret, content = ctx.get_global_state()
    if ret != RET_OK:
        emit(fh, "error", tick, {"error": f"get_global_state: {content}"})
        log(f"{tick} state 失败: {content}")
        return
    emit(fh, "state", tick, {"row": dict(content) if isinstance(content, dict) else content})
    log(f"{tick}: market_hk={content.get('market_hk') if isinstance(content, dict) else '?'}")


def sleep_until(hhmm: str) -> bool:
    """睡到当天的 hh:mm。已过点则返 False (跳过该格, 不补跑 —— 补跑出来的点时间标是假的)。"""
    hour, minute = (int(x) for x in hhmm.split(":"))
    now = datetime.now()
    target = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
    delta = (target - now).total_seconds()
    if delta < 0:
        log(f"跳过 {hhmm} (已过点 {-delta:.0f}s)")
        return False
    log(f"等 {hhmm} ({delta:.0f}s)")
    time.sleep(delta)
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description="hk 期权盘后报价存活 + OI 定稿探针 (只读)")
    ap.add_argument("--codes", default="HK.00700", help="逗号分隔的标的码 (pilot 先单票)")
    ap.add_argument("--out", required=True, help="jsonl 输出路径")
    ap.add_argument("--grid", default=DEFAULT_GRID, help="逗号分隔的 HH:MM 采样点 (宿主机当地时间)")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=11111)
    ap.add_argument("--smoke", action="store_true", help="立刻打一拍就退 (不等网格)")
    ap.add_argument(
        "--mode",
        choices=("chain", "state"),
        default="chain",
        help="chain = 全链报价/OI 曲线; state = 只打 get_global_state (午休状态取证, 一发/拍)",
    )
    args = ap.parse_args()

    underlyings = [c.strip() for c in args.codes.split(",") if c.strip()]
    grid = [g.strip() for g in args.grid.split(",") if g.strip()]

    with open(args.out, "a", encoding="utf-8") as fh:
        emit(fh, "meta", "start", {"underlyings": underlyings, "grid": grid, "smoke": args.smoke})

        # 链发现推迟到第一拍才做 —— 与建连同一条理由 (见 open_ctx): 进程可能提前十几小时挂起,
        # 提前发现出来的合约集在第一格时已是旧的, 而推迟一分钟成本为零。
        codes: list[str] | None = None

        def tick(label: str) -> None:
            nonlocal codes
            ctx = open_ctx(args.host, args.port)
            try:
                if args.mode == "state":
                    state_tick(ctx, label, fh)
                    return
                if codes is None:
                    contracts: list[str] = []
                    for code in underlyings:
                        contracts.extend(discover_contracts(ctx, code, fh))
                    if not contracts:
                        raise RuntimeError("链发现零结果 (标的没有挂牌期权, 或权限不足)")
                    # 标的自己的码进同一批 —— spot 与报价同刻同源, 免得多一发也免得对不上时刻。
                    codes = contracts + underlyings
                    log(f"共 {len(contracts)} 条合约 + {len(underlyings)} 条标的")
                snapshot_tick(ctx, label, codes, fh)
            finally:
                ctx.close()

        if args.smoke:
            tick(datetime.now().strftime("%H:%M"))
            return 0

        for hhmm in grid:
            if not sleep_until(hhmm):
                continue
            try:
                tick(hhmm)
            except Exception as exc:  # noqa: BLE001 —— 单格挂掉不该带走整条曲线
                emit(fh, "error", hhmm, {"error": str(exc)})
                log(f"{hhmm} 整拍失败: {exc}")
        emit(fh, "meta", "done", {"ticks": len(grid)})
        log("网格跑完")
        return 0


if __name__ == "__main__":
    sys.exit(main())
