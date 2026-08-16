#!/usr/bin/env bash
# certbot deploy-hook: re-bind renewed img.shintongtech.com LE cert to the OSS
# custom domain via put-cname. Runs after EVERY renewal, so it no-ops unless the
# img cert was the one renewed (filtered on $RENEWED_DOMAINS). Runs as root
# (certbot is root) -> ossutil reads /root/.ossutilconfig profile.
# Installed on the host at /etc/letsencrypt/renewal-hooks/deploy/10-oss-putcname-img.sh.
set -euo pipefail

# 见 certbot-aliyun-auth.sh 同名行：certbot 由 systemd 触发时无 HOME，ossutil 同样找不到
# profile —— 表现为 "SigningContext.Credentials is null or empty"。
export HOME="${HOME:-/root}"

# 🚨 一次续期横跨两个阿里云账号，别把两边混在一起：
#   - 签发阶段（certbot-aliyun-auth.sh）走 `shintong-dns` profile = **账号 B**，
#     因为域名 shintongtech.com 的云解析仍在 B，DNS-01 的 TXT 必须写到 B 去；
#   - 推送阶段（本脚本）走 **账号 C**，因为桶迁到了 C。
# 把签发那半边也一起换到 C 的话，TXT 写不进去、证书根本签不出来。
DOMAIN=img.shintongtech.com
BUCKET=nvy-profile-images
PROFILE=nvy-oss-cert
REGION=cn-shanghai

# only act when THIS cert (img) was renewed; otherwise silently no-op
case " ${RENEWED_DOMAINS:-} " in
  *" $DOMAIN "*) ;;
  *) exit 0 ;;
esac

BASE="${RENEWED_LINEAGE:-/etc/letsencrypt/live/$DOMAIN}"
TMP=$(mktemp /tmp/oss-cname.XXXXXX.json)
trap 'rm -f "$TMP"' EXIT
chmod 600 "$TMP"

python3 - "$BASE" "$DOMAIN" "$TMP" <<'PY'
import json, sys
base, domain, tmp = sys.argv[1], sys.argv[2], sys.argv[3]
cert = open(base + "/fullchain.pem").read()
key = open(base + "/privkey.pem").read()
cfg = {"Cname": {"Domain": domain, "CertificateConfiguration": {
    "Certificate": cert, "PrivateKey": key, "Force": True}}}
open(tmp, "w").write(json.dumps(cfg))
PY

ossutil api put-cname --bucket "$BUCKET" \
  --cname-configuration "file://$TMP" \
  --profile "$PROFILE" --region "$REGION"

echo "[deploy-hook] re-bound $DOMAIN cert to OSS bucket $BUCKET"
