#!/usr/bin/env bash
# certbot --manual-auth-hook for DNS-01 challenges on *.shintongtech.com.
# Domain-generic: derives the _acme-challenge RR from $CERTBOT_DOMAIN, so the
# SAME hook serves api / img / any future subdomain. Writes the TXT record via
# the Aliyun DNS (alidns) API using the `shintong-dns` CLI profile (account B
# RAM key, alidns-only). Installed on the host at /root/certbot-aliyun-auth.sh.
set -e
# systemd 不给 root 系统服务注入 HOME（只有 User= 存在时才注入），而 aliyun CLI 靠 ~ 定位
# profile 配置。HOME 为空时 ~ 展开成 / ，CLI 报 "unknown profile" → TXT 从没写进去 → LE 查到
# NXDOMAIN。人工 `sudo certbot` 路径 HOME=/root 恒有值，所以这个洞只在 certbot.timer 触发的
# 自动续期里显形（2026-08 api 证书连续 12 天续期失败即此因）。
export HOME="${HOME:-/root}"
PROFILE=shintong-dns
DOMAIN=shintongtech.com
RR="_acme-challenge.${CERTBOT_DOMAIN%.${DOMAIN}}"
aliyun alidns AddDomainRecord --DomainName "$DOMAIN" --RR "$RR" --Type TXT --Value "$CERTBOT_VALIDATION" --profile "$PROFILE" --region cn-hangzhou >/dev/null
echo "added TXT $RR.$DOMAIN ; waiting propagation"
sleep 30
