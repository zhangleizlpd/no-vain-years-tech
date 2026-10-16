#!/usr/bin/env bash
# 代码变更修正 (086, FR-012 / FR-016; plan D6) —— ssh 到 app 主机, 在一次性 app 容器里跑
# dist/optionsdesk/symbol-change.cli.js, 参数原样透传。
#
# 用法 (子命令与参数以 CLI 的 --help 为准, 本脚本不解析):
#   symbol-change.sh --help
#   symbol-change.sh apply  <market> <old> <new> <YYYY-MM-DD> --evidence <text> [--operator x] [--confirm]
#   symbol-change.sh revert <market> <old> <new> <YYYY-MM-DD> --evidence <text> [--operator x] [--confirm]
#   symbol-change.sh list [market]
#   symbol-change.sh candidates [--all]
#   symbol-change.sh dismiss <candidateId> --note <text>
#   symbol-change.sh apply --from-candidate <candidateId> [--new <newCode>] --effective <YYYY-MM-DD> --evidence <text> [--operator x] [--confirm]
#
# 🚨 不带 --confirm 时 CLI 只预览 (零写入) 并打印复述表; 核对无误后加 --confirm 重跑才写。
#
# 执行面与部署的 B2 config 闸同形 (.github/workflows/deploy.yml 的 validate-config 那一步):
#   sops exec-env 内存解密密文 → docker compose run --rm -T --no-deps --entrypoint node app …
#   CLI 在容器内直连 DB, 不走 HTTP、不需要 JWT。
#   MBW_APP_IMAGE 钉为当前在跑的 app 容器镜像 ⇒ CLI 与线上 server 同一版本。
#
# 前置 (仓外, 仓内零标识符 per docs/conventions/information-boundary.md):
#   · ~/.nvy/fleet.env 的 NVY_APP_SSH —— prod ssh 目标
#
# 判断逻辑全在 CLI (退出码透传: 0 成功 / 1 参数错误或某步 failed|conflict)。

set -euo pipefail

readonly SCRIPT_NAME="${0##*/}"
FLEET_ENV="${NVY_FLEET_ENV:-$HOME/.nvy/fleet.env}"
readonly REMOTE_REPO=/home/admin/no-vain-years-mono
readonly APP_CONTAINER=nvy-tight-app-1
readonly CLI_PATH=dist/optionsdesk/symbol-change.cli.js

die() { printf '%s: %s\n' "$SCRIPT_NAME" "$*" >&2; exit 1; }

resolve_ssh() {
  [ -r "$FLEET_ENV" ] || die "读不到 $FLEET_ENV —— 主机标识不入仓, 见 information-boundary.md"
  local v
  v="$(sed -n 's/^NVY_APP_SSH=//p' "$FLEET_ENV" | head -1 | sed 's/#.*//' | tr -d '"'\''' | xargs || true)"
  [ -n "$v" ] || die "$FLEET_ENV 里没有 NVY_APP_SSH"
  printf '%s' "$v"
}

# POSIX 单引号转义: 'it'"'"'s' 形态, sh / bash 都认。参数要过两层远端 shell
# (ssh 登录 shell → sops exec-env 起的 shell), 所以 CLI 参数转一次、整条内层命令再转一次。
# evidence 可能含空格 / URL / & / 引号 —— 一律按字面传到 CLI。
shq() {
  local s=${1//\'/\'\\\'\'}
  printf "'%s'" "$s"
}

[ "$#" -gt 0 ] || set -- --help
target="$(resolve_ssh)"

inner="docker compose -f docker-compose.tight.yml --env-file .env.production run --rm -T --no-deps --entrypoint node app $CLI_PATH"
for a in "$@"; do inner+=" $(shq "$a")"; done

remote="cd $REMOTE_REPO"
remote+=" && export MBW_APP_IMAGE=\"\$(docker inspect -f '{{.Config.Image}}' $APP_CONTAINER)\""
remote+=" && export SOPS_AGE_KEY_FILE=\"\$HOME/.config/sops/age/keys.txt\""
remote+=" && sops exec-env /etc/nvy/secrets.enc.env $(shq "$inner") </dev/null"

rc=0
ssh -o ConnectTimeout=15 "$target" "$remote" || rc=$?

if [[ "$rc" == 0 ]] && [[ "${1:-}" == apply || "${1:-}" == revert ]] && [[ " $* " != *' --confirm '* ]]; then
  printf '\n%s: 以上为预览 (未写入)。确认后加 --confirm 重跑。\n' "$SCRIPT_NAME" >&2
fi
exit "$rc"
