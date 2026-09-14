#!/usr/bin/env bash
# 对照测试：check-identifier-boundary.ts 的 L2 私有清单（private-business-value）—— CLI 三种模式端到端。
# 用法: bash scripts/checks/check-identifier-boundary.test.sh scripts/checks/check-identifier-boundary.ts
#
# 纯函数单测在 check-identifier-boundary.spec.ts；但「main 有没有真去读清单、三种模式有没有都接上」
# 只有跑 CLI 才看得见 —— 定向变异「去掉清单读取」时，纯函数测试全绿。而起临时 git 仓 + 子进程
# 不属于 scripts/checks spec 的 Small 档，故单列成 shell 对照表（同 scripts/hooks/*.test.sh 的形态）。
#
# 被测脚本从**自身位置**推 REPO_ROOT（`git diff --cached` 就在那里跑）⇒ 拷进临时 git 仓执行，
# 不碰真实仓的暂存区。HOME 指到临时目录 ⇒ 本机 ~/.nvy/fleet.env 不参与；清单路径一律经
# NVY_PRIVATE_VALUES_FILE 覆盖。全部值都是合成的。
#
# 第一个参数就是被测脚本路径 ⇒ 定向变异时传一份改坏的拷贝即可，不必动真实文件。
set -u

CHECKER="${1:?usage: $0 <check-identifier-boundary.ts>}"
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
TSX="$ROOT/node_modules/.bin/tsx"
[ -x "$TSX" ] || { echo "❌ 找不到 ${TSX}（先 pnpm install）"; exit 1; }
[ -f "$CHECKER" ] || { echo "❌ 找不到被测脚本 ${CHECKER}"; exit 1; }

# 🚨 必须 realpath：macOS 的 mktemp 给 /var/folders/…，而 /var 是 /private/var 的 symlink。被测脚本
# 靠 `resolve(argv[1]) === fileURLToPath(import.meta.url)` 判定「是入口才跑 main」，两边一个走 symlink
# 一个走真实路径 ⇒ main 不跑、零输出、exit 0 —— 所有「期望绿」的臂**空转通过**（首跑实撞）。
# 故每个放行臂也带「输出必须包含」断言，证明脚本真跑过。
TESTTMP=$(cd "$(mktemp -d)" && pwd -P)
trap 'rm -rf "$TESTTMP"' EXIT
mkdir -p "$TESTTMP/home"
FAILED=0

FAKE='SYNTH-PRIVATE-ORDER-0042'
SHORT='short7x'
LIST="$TESTTMP/private-values.txt"
# 空行与注释行必须在：清单解析若把空行当成模式，会「匹配一切」
printf '%s\n' '# 合成清单' '' '# category: broker-order-id' "$FAKE" '# category: account-phone' "$SHORT" > "$LIST"
MISSING="$TESTTMP/no-such-list.txt"

# 每臂一个独立临时仓，互不污染暂存区。$1 = 仓名；$2 = 暂存文件内容（空 = 不暂存任何文件）
mkrepo() {
  local repo="$TESTTMP/$1"
  mkdir -p "$repo/scripts/checks" "$repo/apps"
  cp "$CHECKER" "$repo/scripts/checks/check-identifier-boundary.ts"
  git -C "$repo" init -q
  if [ -n "${2:-}" ]; then
    printf '%s\n' "$2" > "$repo/apps/x.ts"
    git -C "$repo" add apps/x.ts
  fi
  printf '%s' "$repo"
}

# $1 = 仓；$2 = 清单路径；其余 = checker 参数。输出落 $TESTTMP/out，返回 checker 的 exit code
run() {
  local repo=$1 list=$2
  shift 2
  HOME="$TESTTMP/home" NVY_PRIVATE_VALUES_FILE="$list" \
    "$TSX" "$repo/scripts/checks/check-identifier-boundary.ts" "$@" > "$TESTTMP/out" 2>&1
}

# $1 = 臂名；$2 = red|green；$3 = exit code；$4 = 输出必须包含的串（可空）
expect() {
  local name=$1 want=$2 code=$3 needle=${4:-} got=green
  [ "$code" -ne 0 ] && got=red
  if [ "$got" != "$want" ]; then
    echo "❌ $name — 期望 ${want}，实际 ${got}（exit=${code}）"
    sed 's/^/     /' "$TESTTMP/out" | head -20
    FAILED=1
    return
  fi
  if grep -qF -- "$FAKE" "$TESTTMP/out"; then
    echo "❌ $name — 输出回显了清单里的值"
    FAILED=1
    return
  fi
  if [ -n "$needle" ] && ! grep -qF -- "$needle" "$TESTTMP/out"; then
    echo "❌ $name — 输出缺少「${needle}」"
    sed 's/^/     /' "$TESTTMP/out" | head -20
    FAILED=1
    return
  fi
  echo "✅ $name"
}

echo "── L2 私有清单：三种模式 × 命中 / 放行 ─────────────────────────"

repo=$(mkrepo a "const orderId = '${FAKE}';")
run "$repo" "$LIST" --staged
expect "臂 a：--staged 暂存文件含清单值 ⇒ 红且不回显" red $? 'private-business-value'

repo=$(mkrepo b)
printf 'fix(optionsdesk): 对账订单 %s\n' "$FAKE" > "$TESTTMP/msg-hit.txt"
run "$repo" "$LIST" --commit-msg "$TESTTMP/msg-hit.txt"
expect "臂 b：--commit-msg 含清单值 ⇒ 红且不回显" red $? 'private-business-value'

repo=$(mkrepo c "const orderId = '${FAKE}';")
run "$repo" "$MISSING" --staged
expect "臂 c：清单缺失 ⇒ 绿，并提示未配置" green $? 'L2 私有清单未配置'

repo=$(mkrepo d "const orderId = 'SYNTH-ORDER-PLACEHOLDER';")
run "$repo" "$LIST" --staged
expect "臂 d：暂存内容不含清单值 ⇒ 绿" green $? 'L2 私有清单已启用'

repo=$(mkrepo e "const orderId = '${FAKE}';")
run "$repo" "$LIST"
expect "臂 e：全仓模式（git ls-files）含清单值 ⇒ 红" red $? 'private-business-value'

printf 'fix(optionsdesk): 对账订单改用合成值\n' > "$TESTTMP/msg-clean.txt"
run "$repo" "$LIST" --commit-msg "$TESTTMP/msg-clean.txt"
expect "臂 f：--commit-msg 不含清单值 ⇒ 绿" green $? 'L2 私有清单已启用'

repo=$(mkrepo g "const tag = '${SHORT}';")
run "$repo" "$LIST" --staged
expect "臂 g：清单里短于 8 的值不参与匹配 ⇒ 绿" green $? 'L2 私有清单已启用'

echo
if [ "$FAILED" -eq 0 ]; then
  echo "全部通过"
else
  echo "有用例失败"
  exit 1
fi
