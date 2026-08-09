#!/usr/bin/env bash
# certbot deploy-hook: re-bind renewed img.shintongtech.com LE cert to the OSS
# custom domain via put-cname. Runs after EVERY renewal, so it no-ops unless the
# img cert was the one renewed (filtered on $RENEWED_DOMAINS). Runs as root
# (certbot is root) -> ossutil reads /root/.ossutilconfig profile.
# Installed on the host at /etc/letsencrypt/renewal-hooks/deploy/10-oss-putcname-img.sh.
set -euo pipefail

DOMAIN=img.shintongtech.com
BUCKET=mbw-profile-images
PROFILE=shintong-oss-cert
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
