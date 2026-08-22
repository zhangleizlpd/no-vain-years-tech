---
description: 按市场审批 anchor_submission 待审箱 —— 拉 PENDING 清单 → 停在复述闸等人点头 → 节流导入进锚表 → 盯冷启动跑到出结局。执行体是 ops/bin/anchor-approve.sh，本文只讲怎么下命令、怎么读结果、哪些闸不许绕。
argument-hint: '<us|hk> [数量，如 5；省略则先只出清单]'
allowed-tools: Bash, Read
---

# 审批待审锚（按市场）

访客送进 `optionsdesk.anchor_submission` 的估值只落待审箱，**锚表零变化**。采纳 = 本人用自己的
凭证把同样的值经直写口重放一次（语义单点在 `apps/server/src/optionsdesk/optionsdesk-guest.controller.ts`）。
本 command 就是那件事的批量化。

> 📌 **执行体是 `ops/bin/anchor-approve.sh`，不是你。** 节流 / 429 退避 / 断点续跑 / 翻 CONSUMED /
> 轮询冷启动全在脚本里。你的活儿只有四样：下命令、把清单摆给用户、判异常、照实转述结果。
> **不要自己写 curl 循环** —— 直写口 6 次/分且是漏桶 nodelay，手搓必炸且没有断点。
>
> 📌 五个字段的业务语义 SoT = `services/guest-proxy/playbooks/anchor-submit.md` 第二步。
> 接口契约 SoT = 通道运行时下发的 `/capabilities`。**本文两样都不复述。**

## 三步

```bash
ops/bin/anchor-approve.sh plan  <market>                    # ① 出清单，只读
ops/bin/anchor-approve.sh apply <market> [--limit N]        # ② 复述表，**不发送**
ops/bin/anchor-approve.sh apply <market> [--limit N] --confirm   # ③ 真发
ops/bin/anchor-approve.sh watch <market>                    # ④ 盯冷启动到出结局
```

还有一个**与审批无关**的动词，别跟 `apply` 搞混——两者改的东西完全不同：

```bash
ops/bin/anchor-approve.sh fix-asof <market> [--confirm]     # 修**已有锚自己**的口径日
```

|            | 数据从哪来                                  | 改了什么                                                         | 触发冷启动            |
| ---------- | ------------------------------------------- | ---------------------------------------------------------------- | --------------------- |
| `apply`    | 访客的 `anchor_submission`                  | V / asof / method / confidence **整组换成访客的** = 采纳他的估值 | `create` 会           |
| `fix-asof` | **锚表自己**（送 `a.v` 模型 V，不是生效 V） | **只换 asof**，其余原样重放                                      | 不会（永远 `update`） |

用户说「修一下那几只锚的 asof」时要的是 `fix-asof`。拿 `apply --include-existing` 去做会静默把他的估值换成访客的。

`fix-asof` 自带两道 fail-closed：日历解不出前一交易日 → 拦；锚设了人工位（重放会连人工位一起回落 ⇒ 生效 V / 档位会变，不再是「只换 asof」）→ 拦，要 `--include-manual-slots` 才放行。

🚨 **无法规避的副作用**：`buildModelImportPatch` 里 `confidenceSource:'model'` 是无条件写死的 ⇒ `manual` 源的锚必然翻成 `model`，此后 App 里改不动其置信度且**没有回头路**。脚本会逐条点名，**必须转述给用户再等他点头**。

🚫 **不要提议用裸 SQL 改 `asof` 来「省掉副作用」**——那绕过 `anchor_change` 痕迹表，`GET /anchors/:id/at` 的 PIT 还原会算错，且违反 FR-012「系统 MUST NOT 存在第二条写锚路径」。

`$ARGUMENTS` 第一位是市场（只有 `us` / `hk`），第二位若给了数字就当 `--limit`。
没给数字 ⇒ 只跑 ①，把清单摆出来问用户要发多少。

## 🚨 复述闸 —— 无条件

**先跑不带 `--confirm` 的 ②，把它打印的表原样贴给用户，停下等他点头，再跑 ③。**

这道闸没有例外分支。**不许**推理出「用户在 command 里已经写了数量所以算确认过」——
「用户是不是真的看过这批标的」你从自己的上下文里观测不到，而写进锚表不可逆
（判据同 `docs/conventions/claude-config-layout.md` §护栏措辞）。

脚本自己也拦两样，被拦下**不要加旗子绕**，先回来问用户：

| 拦截                               | 含义                                                                           | 绕过旗子（问过用户才用）                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `asof` = FUTURE / WEEKEND          | 那天的收盘价不存在 ⇒ 提交方的口径日填错了                                      | `--allow-suspect-asof`（照原样发）或 `--shift-suspect-asof`（改送前一交易日） |
| disposition = `refresh` 默认被剔除 | 该标的**你已经有锚**，重放会把 confidence_source 翻成 `model` 并回落三处人工位 | `--include-existing`                                                          |

两个 asof 旗子**处置方向相反、互斥**，脚本同时给会直接拒：

- `--allow-suspect-asof` = 承认口径日是错的但照发，事后再修
- `--shift-suspect-asof` = 按 `marketdata.trading_day` 解析出该日期**之前的最后一个真交易日**并改送。
  🚨 只有当提交方确属「把批次日当成了口径日」时这个修正才成立；若他其实按更早一周的收盘算，
  改完一样是错的。**改的是溯源信息不是 V**，改动会写进 ledger 的 note 列（`asof:旧→新`），
  锚表里只留修正后的值。日历解不出前一个交易日 ⇒ fail-closed 拦下，不猜。

⚠️ 无 FLAG **不等于**那天是交易日 —— 未被标记的行脚本不查日历。别向用户宣称「口径日已验过」。

## 读结果

`apply` 每条打一行 `action=`：

- **`create`** = 新建了一只锚 ⇒ 触发一次冷启动，prod 当日采集要为它多做一整轮历史回填。
  🚨 建多只是**数小时的真 vendor 外呼**（冷启动 worker `concurrency=1`），不是一次 HTTP。
- `update` / `noop` = 刷新既有锚 / 值没变没写。二者**不发建锚事件**，`watch` 不该期待它们出行。
- 打出 `⚠ 人工位被冲` 的行 **必须原样转述给用户** —— 那是他手动调过的判断被这次覆盖了。

`watch` 收敛后按 outcome 分桶。八种 outcome **两两互异不许折叠**（值域权威在
`apps/server/src/marketdata/anchor-cold-start.rules.ts` 的 `COLD_START_OUTCOME`）：

- `backfilled` / `already_present` / `intraday_skipped` / `market_not_enabled` = 正常收敛
- `retry_exhausted` / `backfill_incomplete` / `calendar_missing` / `session_unregistered` /
  `ticker_unresolved` = **做了但没成 / 判不了**，脚本会单列出来。期权 EOD **无跨日补救** ⇒
  这些是永久缺口，如实报给用户，别当噪声吞掉。

`watch` 超时退出不等于失败 —— 队列串行，再跑一次 `watch` 即可。

## 时机（运维约束，系统不拦）

导入要赶在 prod **当日锚驱动采集轮开始之前**，当天新建的锚才会被**当轮**纳入。错过了那只新锚
要等下一轮才有行情。

## 前置

`ops/bin/anchor-approve.sh` 需要 wg2 隧道（脚本用 `/healthz` 自检，**不要用 `wg show`**）+
`~/.nvy/fleet.env` 的 `NVY_APP_SSH` + `~/.config/nvy-futu/token`。三样都在仓外。
隧道没起时脚本会告诉用户自己跑 `sudo wg-quick up` —— **你不要自己 sudo**，会把你挂住。
