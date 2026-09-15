#!/usr/bin/env bash
# nx run server:export-openapi —— 起 dist 实例拉 /docs-json，校验后原子替换 openapi.json。
# 任何失败（端口占用 / boot 退出 / 超时 / 内容非法）都 exit 1，且 openapi.json 保持原样。
set -euo pipefail

PORT=3099
TIMEOUT_S=90
OUT=openapi.json

if lsof -tnP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "❌ export-openapi: 端口 $PORT 已被占用" >&2
  exit 1
fi

TMP="$(mktemp "$OUT.XXXXXX")"
PORT="$PORT" node dist/main.js &
PID=$!
cleanup() {
  kill "$PID" 2>/dev/null || true
  wait "$PID" 2>/dev/null || true
  rm -f "$TMP"
}
trap cleanup EXIT

deadline=$((SECONDS + TIMEOUT_S))
until curl -fsS -o "$TMP" "http://127.0.0.1:$PORT/docs-json" 2>/dev/null; do
  if ! kill -0 "$PID" 2>/dev/null; then
    echo "❌ export-openapi: server boot 失败（见上方日志；worktree 内先确认 apps/server/.env 存在）" >&2
    exit 1
  fi
  if ((SECONDS >= deadline)); then
    echo "❌ export-openapi: ${TIMEOUT_S}s 内 /docs-json 不可达" >&2
    exit 1
  fi
  sleep 0.5
done

if ! node -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(typeof s.openapi === "string" ? 0 : 1)' "$TMP"; then
  echo "❌ export-openapi: /docs-json 返回的不是 OpenAPI 文档" >&2
  exit 1
fi
mv "$TMP" "$OUT"
