#!/usr/bin/env bash
# certbot deploy-hook (runs after ANY successful renewal) — syncs the renewed
# Let's Encrypt tree into the nginx container's docker volume and reloads nginx.
# This is how api.shintongtech.com's cert reaches the dockerized nginx. (The img
# cert is also copied but nginx doesn't serve it — img is served by Aliyun OSS,
# see 10-oss-putcname-img.sh. Harmless overlap.)
# Installed on the host at /etc/letsencrypt/renewal-hooks/deploy/00-copy-volume-reload.sh.
set -e
cp -r /etc/letsencrypt/. /var/lib/docker/volumes/nvy-tight_nvy-letsencrypt/_data/
docker exec nvy-tight-nginx-1 nginx -s reload
