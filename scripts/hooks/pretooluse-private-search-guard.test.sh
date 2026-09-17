#!/usr/bin/env bash
# 对照表测试：pretooluse-private-search-guard.sh
# 用法: bash scripts/hooks/pretooluse-private-search-guard.test.sh scripts/hooks/pretooluse-private-search-guard.sh
# 断言三类：① 命中臂必须注入提醒 ② 静默臂必须零输出 ③ 全部臂 exit 0（fail-open 契约）。
#
# 🚨 承重臂说明（改判据前先读）:
#   · 「--no-ignore 仍提醒」—— 2026-09-17 实测：解掉 gitignore 并不能穿透 symlink，
#     rg --no-ignore 对 docs/private 仍是 0 命中。若哪天把它划进「已能看见」而静默，
#     就会在**最像已经解决了**的写法上漏掉提醒。
#   · 「grep -R 静默 / grep -r 提醒」—— 大小写是唯一区别，同一条命令差一个字母行为相反。
#   · 「ls | grep foo 静默」—— 管道 grep 每个 session 几十条，这条是零误伤的承重回归。
set -u

SCRIPT="${1:?usage: $0 <hook-script>}"
FAILED=0
MARKER='docs/private 搜索盲区'

run_case() {
  local name="$1" cmd="$2" expect="$3" # expect: match | silent
  local json out code
  json=$(/usr/bin/jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')
  out=$(printf '%s' "$json" | bash "$SCRIPT" 2>/dev/null)
  code=$?
  if [ "$code" -ne 0 ]; then
    # 🚨 `${code}` 花括号不可省：裸 `$code` 紧跟全角「（」在 CJK locale 下会被 bash 折进
    #    变量名，`set -u` 当场炸 —— 与 pretooluse-convention-rubric.test.sh 同一个坑。
    echo "❌ $name — exit=${code}（fail-open 契约要求恒 0）"
    FAILED=1
    return
  fi
  case "$expect" in
    match)
      if printf '%s' "$out" | grep -q "$MARKER"; then
        echo "✅ $name"
      else
        echo "❌ $name — 应注入提醒，实际输出: ${out:-<empty>}"
        FAILED=1
      fi
      ;;
    silent)
      if [ -z "$out" ]; then
        echo "✅ $name"
      else
        echo "❌ $name — 应零输出，实际: $out"
        FAILED=1
      fi
      ;;
  esac
}

echo "— 命中臂（搜索范围本该覆盖 docs/private 却覆盖不到）"
run_case "rg 扫 docs/"              "rg -n 'USDCNY' docs/"                      match
run_case "grep -r 扫 docs/"         "grep -rn 'USDCNY' docs/"                   match
run_case "rg 扫 ./docs/"            "rg -n 'X' ./docs/"                         match
run_case "grep -r 扫绝对路径 docs"   "grep -rn 'X' /Users/x/repo/docs"           match
run_case "find 扫 docs"             "find docs -name '*.md'"                    match
run_case "🚨 --no-ignore 仍瞎，仍提醒" "rg --no-ignore -l 'X' docs/"               match
run_case "🚨 引号包裹的 docs 路径"    "find \"\$R/docs\" -iname '*friction*'"      match
run_case "🚨 引号包裹 + grep"        "grep -rn 'X' \"\$REPO/docs\""               match

echo "— 静默臂：已能看见 docs/private 的写法"
run_case "已点名 private"           "rg 'X' docs/private/plans/"                silent
run_case "grep -R（大写=跟随 symlink）" "grep -R 'X' docs/"                       silent
run_case "rg -L（跟随 symlink）"     "rg --no-ignore -L 'X' docs/"               silent
run_case "rg -Ln（合并短选项含 L）"   "rg -Ln 'X' docs/"                          silent

echo "— 静默臂：范围与本盲区无关"
run_case "扫 server 源码"           "rg 'X' apps/server/src"                    silent
run_case "扫 specs/"                "grep -rn 'X' specs/"                       silent
run_case "find 扫 apps"             "find apps -name '*.ts'"                    silent

echo "— 静默臂：仓根 . 蓄意不判（2026-09-17 真实流量回放后收窄，勿凭直觉改回 match）"
# 含仓根时 117 条触发里 115 条 scope 是 `.`、仅 11 条是真 docs 范围，find 独占 83 条。
# 那些是 `find . -name 'openapi.json'` 这类找文件名的，与 docs/private 无关；留着会把
# 这条提醒稀释成背景噪声。判据与代价写在 guard 文件头。
run_case "🚨 rg 扫仓根 ."            "rg -l 'plan' ."                            silent
run_case "🚨 find 扫仓根按文件名"     "find . -name '*.md'"                       silent

echo "— 静默臂：零误伤承重回归"
run_case "🚨 管道 grep（读 stdin）"   "ls | grep foo"                             silent
run_case "省略路径的 rg"            "rg 'USDCNY'"                               silent
run_case "prose: commit 含 grep docs/" "git commit -m 'grep docs/ for X'"       silent
run_case "非搜索命令"               "git status --short"                        silent
run_case "cat 不是搜索"             "cat docs/x.md"                             silent

echo "— fail-open 逆境臂"
for bad in 'not-json-at-all' '' '{"tool_name":"Bash","tool_input":{}}'; do
  out=$(printf '%s' "$bad" | bash "$SCRIPT" 2>/dev/null); code=$?
  if [ "$code" -eq 0 ] && [ -z "$out" ]; then
    echo "✅ 坏输入 → 静默放行: ${bad:-<empty>}"
  else
    echo "❌ 坏输入应静默放行: ${bad:-<empty>} — exit=${code} out=${out:-<empty>}"
    FAILED=1
  fi
done

echo
if [ "$FAILED" -ne 0 ]; then
  echo "—— FAILED"
  exit 1
fi
echo "—— all green"
exit 0
