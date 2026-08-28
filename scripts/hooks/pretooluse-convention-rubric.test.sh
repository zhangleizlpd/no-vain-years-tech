#!/usr/bin/env bash
# 对照表测试：pretooluse-convention-rubric.sh
# 用法: bash scripts/hooks/pretooluse-convention-rubric.test.sh scripts/hooks/pretooluse-convention-rubric.sh
# 断言两类：① 命中臂必须注入 rubric ② 静默臂必须零输出；全部臂 exit 0（fail-open 契约）。
set -u

SCRIPT="${1:?usage: $0 <hook-script>}"
FAILED=0

run_case() {
  local name="$1" json="$2" expect="$3" # expect: match | silent
  local out code
  out=$(printf '%s' "$json" | bash "$SCRIPT" 2>/dev/null)
  code=$?
  if [ "$code" -ne 0 ]; then
    # 🚨 `${code}` 花括号不可省：裸 `$code` 紧跟全角「（」在 CJK locale 下会被 bash 折进变量名，
    #    `set -u` 当场炸 —— 而这条正是「hook 违反 fail-open」时唯一的诊断输出，一炸就整轮中断、
    #    后面的臂全不跑（2026-08-04 实测 zh_TW.UTF-8 + bash 5.3.9；locale 相关，非 bash 版本相关）。
    echo "❌ $name — exit=${code}（fail-open 契约要求恒 0）"
    FAILED=1
    return
  fi
  case "$expect" in
    match)
      if printf '%s' "$out" | grep -q 'CONVENTION 耐久性闸'; then
        echo "✅ $name"
      else
        echo "❌ $name — 应注入 rubric，实际输出: ${out:-<empty>}"
        FAILED=1
      fi
      ;;
    naming)
      if printf '%s' "$out" | grep -q 'DOCS 命名闸'; then
        echo "✅ $name"
      else
        echo "❌ $name — 应注入命名闸，实际输出: ${out:-<empty>}"
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

j() { printf '{"tool_name":"%s","tool_input":{"file_path":"%s"}}' "$1" "$2"; }

# —— 命中臂（历史事故形态：Write 新建 convention）——
run_case "Write 新建 convention" \
  "$(j Write /Users/x/repo/docs/conventions/new-thing.md)" match
run_case "Edit 存量 convention" \
  "$(j Edit /Users/x/repo/docs/conventions/testing.md)" match

# —— 静默臂 ——
run_case "server 源码" "$(j Write /Users/x/repo/apps/server/src/auth/foo.ts)" silent
run_case "improvements 记录（时点数字的合法归宿：注入命名闸而非耐久性闸）" \
  "$(j Write /Users/x/repo/docs/improvements/2026-08/08-03-x.md)" naming
run_case "plans（Write 新建 = 唯一命名时刻）" "$(j Write /Users/x/repo/docs/private/plans/2026-08/08-02-x.md)" naming
run_case "experience" "$(j Edit /Users/x/repo/docs/experience/2026-08/08-02-x.md)" naming
run_case "plans 下非 md" "$(j Write /Users/x/repo/docs/private/plans/2026-08/raw.json)" silent
run_case "conventions 下非 md" "$(j Write /Users/x/repo/docs/conventions/foo.png)" silent

# —— fail-open 逆境臂 ——
run_case "畸形 JSON" 'not-json-at-all' silent
run_case "空输入" '' silent
run_case "缺 file_path" '{"tool_name":"Write","tool_input":{}}' silent

if [ "$FAILED" -ne 0 ]; then
  echo "—— FAILED"
  exit 1
fi
echo "—— all green"
exit 0
