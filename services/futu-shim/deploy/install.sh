#!/usr/bin/env bash
# Install / update futu-shim on the OpenD host. Idempotent: safe to re-run.
#
# Host-agnostic by design (p3b §4.3 requirement 3) — nothing here hardcodes a
# hostname or an IP; the bind address comes from /etc/futu-shim.env.
#
# Usage (from a checkout of this repo, on the target host):
#   sudo services/futu-shim/deploy/install.sh
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR=/opt/futu-shim
ENV_FILE=/etc/futu-shim.env
SERVICE_USER=futushim
OPEND_UNIT=futu-opend.service

[[ $EUID -eq 0 ]] || { echo "must run as root" >&2; exit 1; }

echo "==> service account"
id -u "$SERVICE_USER" &>/dev/null || useradd --system --no-create-home --shell /usr/sbin/nologin "$SERVICE_USER"

echo "==> code -> $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/src" "$APP_DIR/tests"
cp -a "$SRC_DIR/src" "$SRC_DIR/tests" "$SRC_DIR/requirements.txt" \
      "$SRC_DIR/requirements-dev.txt" "$SRC_DIR/pyproject.toml" "$APP_DIR/"

# 🚨 版本闸 (2026-08-01)。此前"港机上跑的是哪个 commit"完全不可观测, 而本脚本 rsync 的是
# **调用者的工作树** —— 从一个落后的分支装一次, 就会静默回退别人已 ship 的改动, 故障要隔好
# 几层才显形 (实际发生过: `/kline` 被抹掉 → server 侧 7 只票全 vendor HTTP 404)。
# 写进文件 + 由 /healthz 吐出 ⇒ "装了哪个版本"变成一条 curl 可见, 部署后自检能直接断言
# "跑着的 SHA == 我刚部署的 SHA"。
# 取值优先级: 调用方显式传入 > 从 SRC_DIR 所在 git 工作树现取 > unknown (不猜、不留空)。
if [[ -n "${NVY_SHIM_VERSION:-}" ]]; then
  VERSION="$NVY_SHIM_VERSION"
elif VERSION=$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null); then
  git -C "$SRC_DIR" diff --quiet HEAD -- "$SRC_DIR" 2>/dev/null || VERSION="$VERSION-dirty"
else
  VERSION=unknown
fi
printf '%s\n' "$VERSION" > "$APP_DIR/VERSION"
echo "    version = $VERSION"
# macOS tars carry AppleDouble sidecars; they break nothing but are noise.
find "$APP_DIR" -name '._*' -delete

echo "==> venv"
[[ -x "$APP_DIR/venv/bin/python" ]] || python3 -m venv "$APP_DIR/venv"
"$APP_DIR/venv/bin/pip" install --quiet --upgrade pip
"$APP_DIR/venv/bin/pip" install --quiet -r "$APP_DIR/requirements-dev.txt"
chown -R root:root "$APP_DIR"

echo "==> $ENV_FILE"
if [[ ! -f $ENV_FILE ]]; then
  # Generated here rather than committed. Copy this value to the consuming
  # server when its adapter lands — same pattern as CODE_INDEX_SERVICE_TOKEN.
  umask 077
  cat > "$ENV_FILE" <<EOF
FUTU_SHIM_TOKEN=$(openssl rand -hex 32)
FUTU_SHIM_HOST=10.89.0.1
FUTU_SHIM_PORT=8811
FUTU_OPEND_UNIT=$OPEND_UNIT
FUTU_OPEND_IDLE_STOP_S=0
EOF
  echo "    generated a new FUTU_SHIM_TOKEN"
else
  echo "    kept existing (never rotate a token that a consumer is already using)"
fi
chown root:root "$ENV_FILE" && chmod 600 "$ENV_FILE"

# 🚨 Non-secret knobs must converge on every deploy. The block above is
# write-once so a live token is never rotated out from under its consumer — but
# leaving the *whole* file write-once meant an existing host kept its old value
# forever while the unit and the code said something else. That is how the
# resident switch (2026-08-04) would have silently no-op'd on the one host that
# matters: OpenD would keep being reaped at 600 s with everything else claiming
# it was resident.
#
# Consequence, stated rather than hidden: an operator rollback (set
# FUTU_OPEND_IDLE_STOP_S=600 by hand + restart futu-shim) is reverted by the next
# deploy. That is the intended split — the env var is the *fast* rollback, making
# it stick is a one-line PR. See ops/runbook/futu-opend-hk.md.
ensure_env_kv() {
  local key=$1 val=$2 cur tmp
  cur=$(sed -n "s|^${key}=||p" "$ENV_FILE" | head -1)
  if [[ $cur == "$val" ]]; then
    echo "    $key=$val (unchanged)"
    return 0
  fi
  tmp=$(mktemp) && chmod 600 "$tmp"
  { grep -v "^${key}=" "$ENV_FILE" || true; printf '%s=%s\n' "$key" "$val"; } > "$tmp"
  # Never hand back an env file without the token: the shim is fail-closed on a
  # missing token, so a botched rewrite here would take the service down.
  grep -q '^FUTU_SHIM_TOKEN=.' "$tmp" || {
    rm -f "$tmp"; echo "refusing to write $ENV_FILE without a token" >&2; exit 1
  }
  mv "$tmp" "$ENV_FILE"
  chown root:root "$ENV_FILE" && chmod 600 "$ENV_FILE"
  echo "    $key: ${cur:-(absent)} -> $val"
}
ensure_env_kv FUTU_OPEND_IDLE_STOP_S 0

echo "==> sudoers (narrow: three verbs, one unit)"
SUDOERS=/etc/sudoers.d/futu-shim
cat > /tmp/futu-shim.sudoers <<EOF
$SERVICE_USER ALL=(root) NOPASSWD: /usr/bin/systemctl start $OPEND_UNIT, /usr/bin/systemctl stop $OPEND_UNIT, /usr/bin/systemctl is-active $OPEND_UNIT
EOF
visudo -cf /tmp/futu-shim.sudoers
install -m 0440 -o root -g root /tmp/futu-shim.sudoers "$SUDOERS"
rm -f /tmp/futu-shim.sudoers

echo "==> units"
install -m 0644 "$SRC_DIR/deploy/futu-opend.service" /etc/systemd/system/"$OPEND_UNIT"
install -m 0644 "$SRC_DIR/deploy/futu-shim.service" /etc/systemd/system/futu-shim.service
systemctl daemon-reload
# futu-opend IS enabled as of 2026-08-04: it is resident now, so it must come
# back on its own after a reboot rather than waiting for the first request.
# (Before that it was deliberately left un-enabled — and the unit deliberately
# had no [Install] section so `systemctl enable` would fail loudly. Both were
# guards for a premise that V9/V10 falsified; see the unit header.)
# `--now` is a no-op when it is already running, so a redeploy never restarts a
# healthy gateway — futu-shim is the one that gets restarted below.
systemctl enable --now "$OPEND_UNIT"
systemctl enable --now futu-shim.service
systemctl restart futu-shim.service

echo "==> verify"
BIND_HOST=$(grep -oP '(?<=^FUTU_SHIM_HOST=).*' "$ENV_FILE")
BIND_PORT=$(grep -oP '(?<=^FUTU_SHIM_PORT=).*' "$ENV_FILE")
# Poll /healthz, not `systemctl is-active`. Under Type=simple "active" means
# only that the process was spawned; importing the futu SDK pulls in pandas and
# takes ~1s more before waitress binds, so is-active races the listener.
for _ in {1..20}; do
  if curl -fsS --max-time 2 "http://${BIND_HOST}:${BIND_PORT}/healthz" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [[ ${ready:-0} -ne 1 ]]; then
  echo "futu-shim never answered /healthz:" >&2
  systemctl status futu-shim.service --no-pager -l >&2 || true
  journalctl -u futu-shim.service -n 40 --no-pager >&2 || true
  exit 1
fi
curl -fsS "http://${BIND_HOST}:${BIND_PORT}/healthz" && echo
echo "done."
