#!/usr/bin/env bash
# feishu-send.sh — 低层「推一条文本到飞书自定义机器人」原语（source 进各定时脚本 / wrapper 用）。
#
# 全仓 host/OS 级定时任务的飞书传输**唯一出口**：webhook / 签名 / curl 只此一处实现，新增调度
# 复用 `feishu_send`，不再各写一遍（满足「每台机器复用公共 webhook/token，不要每加一个调度就重写」）。
#
# 配置经 env 注入（每机一个共享文件：本地 `~/.nvy/feishu-alert.env`；prod `/etc/nvy-alert.env`）：
#   NVY_ALERT_WEBHOOK_URL    飞书自定义机器人 webhook；**未设 → 静默跳过**（优雅降级，不挂主流程）。
#   NVY_ALERT_FEISHU_SECRET  bot「签名校验」密钥；启用签名校验后**必填**（空 → 飞书拒收，打 warning）。
#
# 用法：  . "<dir>/feishu-send.sh";  feishu_send "多行\n文本"
# 推送失败一律吞掉（返回 0）：告警是尽力而为，绝不改变调用方退出码。
#
# 依赖：openssl（算签名，免 python3）、awk（JSON 转义）、curl —— 三者 macOS / Linux 皆自带。

# stdin（任意文本，含换行 / 引号 / 反斜杠）→ JSON 字符串字面量内容（不含外层引号）。
# 纯 awk，免 python3 / jq；按行读、行间补 \n；转义 \ 与 "、\t，剔除 \r。
_nvy_json_escape() {
  awk '
    BEGIN { ORS = "" }
    {
      s = $0
      gsub(/\r/, "", s)
      gsub(/\\/, "\\\\", s)
      gsub(/"/, "\\\"", s)
      gsub(/\t/, "\\t", s)
      if (NR > 1) printf "\\n"
      printf "%s", s
    }
  '
}

# feishu_send <text> —— 推一条 text 消息到飞书 bot。无 webhook 静默跳过；失败吞掉。
feishu_send() {
  [ -n "${NVY_ALERT_WEBHOOK_URL:-}" ] || return 0

  local esc body ts sign
  esc="$(printf '%s' "$1" | _nvy_json_escape)"

  if [ -n "${NVY_ALERT_FEISHU_SECRET:-}" ]; then
    ts="$(date +%s)"
    # 飞书签名：base64(HMAC-SHA256(key=`${ts}\n${secret}`, data=''))；openssl 算，免 python3
    sign="$(printf '' | openssl dgst -sha256 -hmac "$(printf '%s\n%s' "$ts" "$NVY_ALERT_FEISHU_SECRET")" -binary | base64)"
    body="$(printf '{"timestamp":"%s","sign":"%s","msg_type":"text","content":{"text":"%s"}}' "$ts" "$sign" "$esc")"
  else
    # webhook 配了但 secret 空：若 bot 已开签名校验，本条会被飞书拒收 → 给一行 warning（stderr，不挂）
    printf '[feishu-send] WARN: NVY_ALERT_FEISHU_SECRET 未设；若 bot 已开签名校验，本条会被拒收\n' >&2
    body="$(printf '{"msg_type":"text","content":{"text":"%s"}}' "$esc")"
  fi

  curl -fsS -m 15 -X POST "$NVY_ALERT_WEBHOOK_URL" \
    -H 'Content-Type: application/json' -d "$body" >/dev/null 2>&1 || true
}
