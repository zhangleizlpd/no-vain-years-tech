#!/usr/bin/env bash
#
# futu-shim-health.sh — 港机 futu-shim / OpenD 存活探针。**跑在 77，不跑在港机。**
#
# 为什么在 77：消费者在 77，判据必须是「77 还能不能从港机拿到数据」。探针放港机只能证明
# 「港机自认为好着」—— B↔C 隧道断 / 港机整机宕 / 境外网络断这三种，港机自己一条都报不出来
# （「本机看门狗逃不出整机宕」这条教训 scheduled-tasks.md 已经记过）。附带好处：港机的凭证面
# 保持为零 —— 它连 GitHub 凭证都没有，那是 remote-deploy.sh forced-command 设计的一部分，
# 为了一条告警在上面放 webhook + secret 是净亏。
#
# 判据（`/healthz` 三元组）。探针 side-effect free：`status()` 明确永不启动 OpenD，也不刷新
# shim 的 idle 时钟 ⇒ 探针不会把它要探的故障自愈掉，也不污染常驻观测。
#   1. 重试后仍取不到 /healthz               → 🔴 港机宕 / 隧道断 / futu-shim 挂
#   2. opend_unit_active = false             → 🔴 OpenD 不在（Restart=always 拉不回，或被 stop）
#   3. opend_connected = true 且 qot_logined = false → 🔴 网关活着但行情登录态掉了（最阴的一种：
#      采集会静默失败，unit 看着一切正常）
#
# 🚨 显式**不报**的三种，别顺手加：
#   · opend_connected = false / qot_logined = null —— shim 重启后没人打过数据请求时的**正常态**
#     （ctx 尚未建立）。当红报 = 永久假红。代价说明白：这段时间「登录态掉了」探不到，是**已知
#     盲区**，不假装覆盖 —— 稳态下 ctx 常驻（2026-08-04 实测 12min 不掉），盲区只在重启后到
#     第一次数据请求之间那一小段，而那段时间 OpenD 本来也没人用。
#   · 「OpenD 崩过」本身 —— Restart=always 会自愈（2026-08-04 实测 SIGKILL 后 11s 拉回）。逐次
#     崩溃报警 = 狼来了。4h 一探 + 只看当下状态 ⇒ 天然只逮住**持续**不可用，那才需要人介入。
#   · idle_stop_seconds != 0 —— 那是 futu-opend.service 头部写明的**快速回滚开关**（人为设 600
#     = 有意退回窗口化）。对它报警 = 对运维的正常动作报警。它只进 summary 行供人读。
#
# 🚨 不打真数据请求（/kline 之类）做端到端验证：那会刷新 shim 的 idle 时钟、消耗 vendor 额度，
#    而三元组已足够判活。要端到端，看每日 09:00 的 marketdata-sync-report（它本就是端到端的）。
#
# 退出码：0 = 健康 / 非零 = 需要人看。**探针自身故障也非零**（取不到、解析不了）—— 探不动 ≠ 健康，
# 沉默被读成正常正是 2026-08-01 那类事故的病灶形状。
#
# 飞书推送由外层 `nvy-run-reported` wrapper 据退出码统一推（webhook/签名在 feishu-send.sh），
# 本脚本零飞书 I/O —— 满足「新增调度复用既有飞书基建」（scheduled-tasks.md 新增 checklist 2）。
#
# Config — 可选 EnvironmentFile /etc/futu-shim-health.env（仅接线，不含判据）：
#   FUTU_SHIM_HEALTH_URL        /healthz 地址（默认 http://10.89.0.1:8811/healthz = 隧道内港机）
#   FUTU_SHIM_HEALTH_TRIES      取不到时的总尝试次数（默认 3，退避 3s / 6s）
#   FUTU_SHIM_HEALTH_TIMEOUT_S  单次 curl 超时秒（默认 8）
set -uo pipefail

URL="${FUTU_SHIM_HEALTH_URL:-http://10.89.0.1:8811/healthz}"
TRIES="${FUTU_SHIM_HEALTH_TRIES:-3}"
TIMEOUT_S="${FUTU_SHIM_HEALTH_TIMEOUT_S:-8}"

command -v python3 >/dev/null 2>&1 || {
  printf '%s\n' "探针失效: 本机没有 python3（用于解析 /healthz JSON）" >&2
  exit 1
}

# 跨境隧道走公网，单次丢包/抖动不该叫人起来 → 重试后仍失败才算不可达。
# 同 check-index-freshness.sh 的 ls-remote 重试思路（真·持续断仍会全失败 → 照常告警）。
body=""
attempt=1
while [ "$attempt" -le "$TRIES" ]; do
  body="$(curl -fsS --max-time "$TIMEOUT_S" "$URL" 2>/dev/null)" && [ -n "$body" ] && break
  body=""
  [ "$attempt" -lt "$TRIES" ] && sleep $(( attempt * 3 ))
  attempt=$(( attempt + 1 ))
done

if [ -z "$body" ]; then
  printf '%s\n' "❌ 取不到 ${URL}（${TRIES} 次尝试全失败）"
  printf '%s\n' "futu-shim 存活告警: 港机不可达 —— 整机宕 / B↔C 隧道断 / futu-shim 挂，三者之一" >&2
  exit 1
fi

# 只取值、不判断：三个状态字段规范化成 true / false / null **三态字符串**再交给下面的显式比较。
# 三态是必须的 —— qot_logined 的 null（没握 ctx，正常）与 false（登录态掉了，故障）语义相反，
# 在 bash 里直接对 JSON 做字符串匹配最容易把这两者混成一个，那正是本探针最该分清的一处。
fields="$(printf '%s' "$body" | python3 -c '
import json, sys

d = json.load(sys.stdin)


def tri(v):
    return "null" if v is None else ("true" if v else "false")


def val(v):
    # None 走 "null" 而非 str(None)：摘要行是给人读的，"idle=Nones" 只会让人愣一下
    return "null" if v is None else str(v)


print("\t".join([
    tri(d.get("opend_unit_active")),
    tri(d.get("opend_connected")),
    tri(d.get("qot_logined")),
    val(d.get("version", "?")),
    val(d.get("idle_seconds")),
    val(d.get("idle_stop_seconds")),
]))
' 2>/dev/null)" || fields=""

if [ -z "$fields" ]; then
  printf '%s\n' "❌ /healthz 有响应但解析不出预期字段（装的是旧版 shim？）"
  printf '%s\n' "futu-shim 存活告警: /healthz 返回体不是预期 JSON —— 原文首 200 字符:" >&2
  printf '%.200s\n' "$body" >&2
  exit 1
fi

IFS=$'\t' read -r unit_active connected qot version idle idle_stop <<<"$fields"
# 字段名与 /healthz 的 JSON key 对齐（idle_seconds / idle_stop_seconds 不缩写、不加单位后缀）：
# 排障的人拿这行能 1:1 对上一次 curl 的输出，不用在脑子里做一次翻译。
summary="version=${version} unit_active=${unit_active} connected=${connected} qot_logined=${qot} idle_seconds=${idle} idle_stop_seconds=${idle_stop}"

problems=""
if [ "$unit_active" != "true" ]; then
  problems="${problems}OpenD unit 不在 active —— Restart=always 没能拉回（撞 StartLimitBurst 停在 failed？）或被人 stop\n"
fi
# 前置 connected=true 是必需的：connected=false 时 qot_logined 恒为 null（没 ctx 可探），
# 不加这条就会把「没人用过」当成「登录态掉了」，变成重启后必红。
if [ "$connected" = "true" ] && [ "$qot" = "false" ]; then
  problems="${problems}OpenD 活着但行情登录态掉了（qot_logined=false）—— 采集会静默失败\n"
fi

if [ -z "$problems" ]; then
  printf '%s\n' "✅ futu-shim 健康 ${summary}"
  exit 0
fi

printf '%s\n' "❌ ${summary}"
printf '%b' "futu-shim 存活告警:\n${problems}排障入口: ops/runbook/futu-opend-hk.md\n" >&2
exit 1
