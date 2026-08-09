#!/usr/bin/env bash
# certbot --manual-auth-hook for DNS-01 challenges on *.shintongtech.com.
# Domain-generic: derives the _acme-challenge RR from $CERTBOT_DOMAIN, so the
# SAME hook serves api / img / any future subdomain. Writes the TXT record via
# the Aliyun DNS (alidns) API using the `shintong-dns` CLI profile (account B
# RAM key, alidns-only). Installed on the host at /root/certbot-aliyun-auth.sh.
set -e
PROFILE=shintong-dns
DOMAIN=shintongtech.com
RR="_acme-challenge.${CERTBOT_DOMAIN%.${DOMAIN}}"
aliyun alidns AddDomainRecord --DomainName "$DOMAIN" --RR "$RR" --Type TXT --Value "$CERTBOT_VALIDATION" --profile "$PROFILE" --region cn-hangzhou >/dev/null
echo "added TXT $RR.$DOMAIN ; waiting propagation"
sleep 30
