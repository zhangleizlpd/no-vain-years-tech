#!/usr/bin/env bash
#
# rollback-prod.sh — roll the prod app container back to a known-good image tag.
#
# Run ON the production ECS host, from the repo clone (/home/admin/no-vain-years-mono):
#   ops/bin/rollback-prod.sh            # → .last-good-tag (last deploy that passed healthcheck)
#   ops/bin/rollback-prod.sh v0.3.1     # → an explicit ACR tag you pick
#
# Mechanism = deploy-in-reverse: re-pin MBW_VERSION in .env.production + recreate
# the app container only. postgres / redis / nginx are untouched.
#
# ⚠️ Image-only rollback. Safe ONLY if the release being undone used backward-
# compatible (expand-migrate-contract) DB migrations — see
# .claude/rules/migration-rules.md § 2. A destructive forward migration cannot be
# cleanly image-rolled-back (old code would meet a newer schema).
#
# Also invoked automatically by .github/workflows/deploy.yml when a fresh deploy
# fails its healthcheck (auto-revert to .last-good-tag → restore uptime).
set -euo pipefail

COMPOSE_FILE="docker-compose.tight.yml"
ENV_FILE=".env.production"
APP_CONTAINER="nvy-tight-app-1"
LAST_GOOD_FILE=".last-good-tag"
# 镜像仓地址含实例 ID → 不入库（per docs/conventions/information-boundary.md）。
# 两条来源：① deploy.yml 触发的自动回滚 —— 继承其 export 的 NVY_ACR_REPO；
# ② 人工跑 —— 从 /etc/nvy-fleet.env 取。都没有就**响亮失败**，绝不猜一个镜像名。
[ -n "${NVY_ACR_REPO:-}" ] || { [ -f /etc/nvy-fleet.env ] && . /etc/nvy-fleet.env; }
ACR_REPO="${NVY_ACR_REPO:?缺 NVY_ACR_REPO —— 写 /etc/nvy-fleet.env（模板见 ops/host/fleet.env.example）}"
# 🚨 必须 export：下面的 `docker compose` 是**子进程**，compose 的 ${NVY_ACR_REPO} 插值读的是
#    环境变量，不是本 shell 的变量。`. /etc/nvy-fleet.env` 只赋 shell 变量，不导出。
#    漏了它的症状：compose 报 `required variable NVY_ACR_REPO is missing a value` 而**脚本前面
#    的赋值明明成功了** —— 极易误判成 fleet.env 没写对。
#    ⚠️ 自动回滚那条分支不会暴露这个 bug（它继承 deploy.yml 已 export 的同名变量），
#    只有人工跑才炸 —— 2026-08-08 回滚演练实测抓到。
export NVY_ACR_REPO

TARGET_TAG="${1:-}"
if [ -z "$TARGET_TAG" ] && [ -f "$LAST_GOOD_FILE" ]; then
  TARGET_TAG="$(cat "$LAST_GOOD_FILE")"
fi
if [ -z "$TARGET_TAG" ]; then
  echo "❌ no rollback tag — pass one explicitly (e.g. $0 v0.3.1) or populate $LAST_GOOD_FILE" >&2
  exit 1
fi

echo "↩️  rolling back app → $TARGET_TAG"

# Re-pin the rollback image tag via shell env (mirror deploy.yml). compose reads
# ${MBW_VERSION} from the shell ahead of --env-file, so this wins; the sops exec-env
# child below inherits it. export — NOT sed "$ENV_FILE" — keeps the now-tracked
# .env.production pristine (no working-tree drift; no backup file needed). MBW_APP_IMAGE
# stays unset so the ACR default image path applies.
export MBW_VERSION="$TARGET_TAG"

# Prefer the locally-cached image (fast, no registry); pull only if absent
# (requires a prior `docker login` to ACR — deploy.yml's auto-rollback path
# still has its login session; a manual run may need you to log in first).
if ! docker image inspect "$ACR_REPO:$TARGET_TAG" >/dev/null 2>&1; then
  echo "image $TARGET_TAG not cached locally — pulling from ACR (needs prior 'docker login')..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" pull app
fi

# Prod secret injection — mirror deploy.yml (ops/runbook/secrets-sops.md)。密文**不在仓内**
# （2026-08-08 起 untracked，仓已公开），常驻主机 /etc/nvy/secrets.enc.env。
#
# 🚨 刻意 fail-closed。旧版这里判的是仓内 `[ -f secrets.enc.env ]`，密文一移出仓该条件恒假
#    → 回落明文分支 → 把 app **重建成一个没有任何 secret 的实例**。而本脚本正是 deploy.yml
#    的**自动回滚**路径：一次失败部署会把 prod 自动"修复"成静默降级状态，且 healthcheck
#    很可能照样绿（/healthz/live 不碰那些 secret）。宁可回滚失败得响亮，也不要回滚成功得虚假。
NVY_SECRETS_ENC="${NVY_SECRETS_ENC:-/etc/nvy/secrets.enc.env}"
if ! command -v sops >/dev/null 2>&1; then
  echo "❌ sops 未安装 —— 无法注入密文，拒绝在无 secret 状态下重建 app" >&2
  exit 1
fi
if [ ! -f "$NVY_SECRETS_ENC" ]; then
  echo "❌ 密文缺失：$NVY_SECRETS_ENC —— 拒绝在无 secret 状态下重建 app" >&2
  echo "   恢复（dev 机）：scp ~/.nvy/secrets.enc.env \"\$NVY_APP_SSH\":/tmp/s.enc.env && \\" >&2
  echo "     ssh \"\$NVY_APP_SSH\" 'sudo install -D -m 640 -o root -g admin /tmp/s.enc.env $NVY_SECRETS_ENC && rm -f /tmp/s.enc.env'" >&2
  exit 1
fi
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$HOME/.config/sops/age/keys.txt}"
sops exec-env "$NVY_SECRETS_ENC" \
  "docker compose -f $COMPOSE_FILE --env-file $ENV_FILE up -d --force-recreate app"

# Wait up to 120s for healthcheck (mono /healthz/live; same loop as deploy.yml).
HEALTHY=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  sleep 10
  STATE=$(docker inspect "$APP_CONTAINER" --format='{{.State.Health.Status}}' 2>/dev/null || echo none)
  echo "[t+$((i * 10))s] app health = $STATE"
  if [ "$STATE" = "healthy" ]; then
    HEALTHY=true
    break
  fi
done

if [ "$HEALTHY" != "true" ]; then
  echo "❌ rollback target $TARGET_TAG did NOT become healthy within 120s — last logs:" >&2
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" logs --tail=80 app >&2
  exit 1
fi

# Public-path smoke (nginx + TLS + reverse-proxy + DNS).
curl -fsS --retry 3 https://api.shintongtech.com/healthz/live >/dev/null

# Record the now-running healthy tag as the new last-good baseline.
echo "$TARGET_TAG" >"$LAST_GOOD_FILE"

echo "✅ rolled back to $TARGET_TAG and healthy."
