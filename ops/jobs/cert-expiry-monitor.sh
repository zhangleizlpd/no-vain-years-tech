#!/usr/bin/env bash
#
# cert-expiry-monitor.sh — daily TLS cert expiry monitor for the two prod domains.
#
# Probes the LIVE SERVED certificate (not the local /etc/letsencrypt file) for
# each domain, so it catches BOTH renewal-deploy gaps the auto-renewal cannot
# self-detect:
#   - api.shintongtech.com : cert renewed but nginx not reloaded (deploy-hook 00 failed)
#   - img.shintongtech.com : cert renewed but put-cname to OSS failed (deploy-hook 10
#                            failed) — OSS keeps serving the OLD cert silently.
#
# Prints a per-domain report to stdout and exits non-zero on any problem (a served cert
# within THRESHOLD days of expiry, or a TLS probe failure) so the systemd unit is marked
# failed (journalctl / `systemctl --failed` visible). Run daily, WRAPPED by the generic
# reporter (ExecStart=… nvy-run-reported cert-expiry -- cert-expiry-monitor.sh): the wrapper
# pushes the daily ✅ report on success and 🔴 on failure to Feishu — webhook/签名 live
# there, config via /etc/nvy-alert.env (NVY_ALERT_*). This script does NO Feishu I/O itself.
#
# Config — optional EnvironmentFile /etc/cert-monitor.env (task tuning only):
#   CERT_ALERT_THRESHOLD_DAYS  days-left threshold to alert (default 21).
#   CERT_MONITOR_DOMAINS       space-separated domains (default the two prod domains).
set -uo pipefail

THRESHOLD_DAYS="${CERT_ALERT_THRESHOLD_DAYS:-21}"
DOMAINS="${CERT_MONITOR_DOMAINS:-api.shintongtech.com img.shintongtech.com}"

now=$(date +%s)
problems=""
report=""

for d in $DOMAINS; do
  end=$(echo | openssl s_client -connect "$d:443" -servername "$d" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | sed 's/notAfter=//')
  if [ -z "$end" ]; then
    problems="${problems}${d}: TLS 握手/取证书失败\n"
    report="${report}${d}: ❌ TLS 握手失败\n"
    continue
  fi
  end_ts=$(date -d "$end" +%s 2>/dev/null || echo 0)
  if [ "$end_ts" -eq 0 ]; then
    problems="${problems}${d}: 无法解析到期时间 ($end)\n"
    report="${report}${d}: ❌ 到期时间解析失败 ($end)\n"
    continue
  fi
  days=$(( (end_ts - now) / 86400 ))
  report="${report}${d}: notAfter=${end} (${days}d left)\n"
  if [ "$days" -lt "$THRESHOLD_DAYS" ]; then
    problems="${problems}${d}: 证书 ${days}d 后过期 (<${THRESHOLD_DAYS}d 阈值)\n"
  fi
done

printf '%b' "$report"

if [ -z "$problems" ]; then
  echo "✅ 所有证书有效期均 > ${THRESHOLD_DAYS}d"
  exit 0
fi

# 有问题 → 打到 stderr 并非零退出。飞书推送由外层 nvy-run-reported wrapper 据退出码统一推
# （wrapper 抓 stdout/stderr 末尾入 report，已带 machine+task，无需本脚本自带 hostname/关键词）。
printf '%b' "TLS 证书过期监控告警:\n${problems}" >&2
exit 1
