#!/usr/bin/env bash
# certbot --manual-cleanup-hook — removes the DNS-01 TXT record created by
# certbot-aliyun-auth.sh after validation. Domain-generic (same derivation).
# Installed on the host at /root/certbot-aliyun-cleanup.sh.
set -e
PROFILE=shintong-dns
DOMAIN=shintongtech.com
RR="_acme-challenge.${CERTBOT_DOMAIN%.${DOMAIN}}"
IDS=$(aliyun alidns DescribeDomainRecords --DomainName "$DOMAIN" --RRKeyWord "$RR" --profile "$PROFILE" --region cn-hangzhou | python3 -c "import sys,json
d=json.load(sys.stdin).get('DomainRecords',{}).get('Record',[])
[print(r['RecordId']) for r in d if r.get('Type')=='TXT' and r.get('Value')=='$CERTBOT_VALIDATION']")
for id in $IDS; do aliyun alidns DeleteDomainRecord --RecordId "$id" --profile "$PROFILE" --region cn-hangzhou >/dev/null; echo "deleted record $id"; done
