#!/usr/bin/env bash
# 对照表测试：pretooluse-comment-provenance.sh
# 用法: bash scripts/hooks/pretooluse-comment-provenance.test.sh scripts/hooks/pretooluse-comment-provenance.sh
#
# 断言四类：① 命中臂注入 rubric ② 静默臂零输出 ③ 去重（含跨通道）④ 全部臂 exit 0（fail-open）。
# 每条用例各用一个 session_id 隔离 marker；去重用例**蓄意复用** session_id。
#
# 🚨 命令类用例的 JSON 一律由 jq `--arg` 生成，不手写。首版手写时把 `sed -i '' …` 的 shell
# 引号嵌套写成了非法 JSON 转义 `\'`，hook 按 fail-open 静默 ⇒ 那一臂**看起来像 hook 漏判，
# 实际是夹具自己坏了**。夹具坏掉的表现与被测物失败完全同形，是最贵的一类假红。
set -u

SCRIPT="${1:?usage: $0 <hook-script>}"
JQ=/usr/bin/jq
FAILED=0
# 🚨 必须隔离 TMPDIR：hook 的 marker 落在 $TMPDIR 下，跟真实 session 共用会让「去重」臂
# 随上一次手工试跑的残留而变绿变红 —— 那正是最难查的一类假绿。
TESTTMP=$(mktemp -d)
trap 'rm -rf "$TESTTMP"' EXIT
SQ="'"   # 供含单引号的命令夹具使用，避开 shell 的 '"'"' 嵌套

assert() {
  local name="$1" json="$2" expect="$3" # expect: bash | write | silent
  local out code
  out=$(printf '%s' "$json" | TMPDIR="$TESTTMP" bash "$SCRIPT" 2>/dev/null)
  code=$?
  if [ "$code" -ne 0 ]; then
    # 🚨 `${code}` 花括号不可省：裸 `$code` 紧跟全角「（」在 CJK locale 下会被 bash 折进
    #    变量名，`set -u` 当场炸 —— 与 pretooluse-convention-rubric.test.sh 同一个坑。
    echo "❌ $name — exit=${code}（fail-open 契约要求恒 0）"
    FAILED=1
    return
  fi
  case "$expect" in
    bash)
      if printf '%s' "$out" | grep -q '你正在读 / 改「外部世界断言」高发区的文件'; then
        echo "✅ $name"
      else
        echo "❌ $name — 应注入 rubric（Bash 措辞），实际: ${out:-<empty>}"
        FAILED=1
      fi
      ;;
    write)
      if printf '%s' "$out" | grep -q '你正在写「外部世界断言」的高发区'; then
        echo "✅ $name"
      else
        echo "❌ $name — 应注入 rubric（Write/Edit 措辞），实际: ${out:-<empty>}"
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

# Bash 通道：命令串交给 jq 转义。
cmd_case() {
  local name="$1" sid="$2" cmd="$3" expect="$4"
  assert "$name" "$("$JQ" -n --arg s "$sid" --arg c "$cmd" \
    '{session_id:$s,tool_input:{command:$c}}')" "$expect"
}
# Write / Edit 通道：单个 file_path。
path_case() {
  local name="$1" sid="$2" fp="$3" expect="$4"
  assert "$name" "$("$JQ" -n --arg s "$sid" --arg f "$fp" \
    '{session_id:$s,tool_input:{file_path:$f}}')" "$expect"
}

echo "── Write / Edit 通道（既有行为，回归）───────────────────────"
path_case "Write 覆盖面 adapter"        w1 /repo/apps/server/src/marketdata/futu.adapter.ts        write
path_case "Edit 覆盖面 optionsdesk rules" w2 /repo/apps/server/src/optionsdesk/anchor.rules.ts      write
path_case "Write 覆盖面 port"           w3 /repo/apps/server/src/marketdata/realtime-quote.port.ts  write
path_case "Write ADR"                   w4 /repo/docs/adr/0070-anchor.md                            write
path_case "Write 非覆盖面 (.service.ts)" w5 /repo/apps/server/src/marketdata/sync.service.ts        silent
path_case "Write 非覆盖面 (.spec.ts)"    w6 /repo/apps/server/src/marketdata/futu.adapter.spec.ts   silent

echo "── Bash 通道（本次新增；探针 B1 / B6a 实测的洞）─────────────"
cmd_case "Bash cat 覆盖面（相对路径）" b1 "cat apps/server/src/marketdata/futu.adapter.ts" bash
cmd_case "Bash sed -n 覆盖面（绝对路径）" b2 "sed -n 1,50p /repo/apps/server/src/optionsdesk/leg-derive.rules.ts" bash
cmd_case "Bash heredoc 写覆盖面（B6a 的形状）" b3 \
  "cat > apps/server/src/optionsdesk/anchor.rules.ts <<'EOF'
const x = 1;
EOF" bash
cmd_case "Bash sed -i 改 ADR（含单引号）" b4 "sed -i ${SQ}${SQ} s/a/b/ docs/adr/0066-time.md" bash
cmd_case "Bash 双引号 + 管道包裹的路径" b5 \
  'grep -n foo "apps/server/src/marketdata/eod.port.ts" | head -20' bash
cmd_case "Bash 单引号包裹的路径" b6 \
  "cat ${SQ}apps/server/src/marketdata/futu.adapter.ts${SQ}" bash
cmd_case "Bash 只提目录（不该命中）" b7 "ls apps/server/src/marketdata/" silent
cmd_case "Bash 非覆盖面文件" b8 "cat apps/server/src/main.ts" silent
cmd_case "Bash 覆盖面的 .spec.ts（不该命中）" b9 "cat apps/server/src/marketdata/futu.adapter.spec.ts" silent
cmd_case "Bash 非覆盖面 (.service.ts)" b10 "cat apps/server/src/marketdata/sync.service.ts" silent

echo "── 去重 ─────────────────────────────────────────────────────"
cmd_case "去重 1/2：首次注入" d1 "cat apps/server/src/marketdata/futu.adapter.ts" bash
cmd_case "去重 2/2：同 session 同文件静默" d1 "cat apps/server/src/marketdata/futu.adapter.ts" silent
cmd_case "跨通道去重 1/2：Bash 相对路径先命中" d2 "cat apps/server/src/marketdata/futu.adapter.ts" bash
path_case "跨通道去重 2/2：Write 绝对路径同文件应静默" d2 \
  /repo/apps/server/src/marketdata/futu.adapter.ts silent
cmd_case "多文件一条命令：只注入一次" d3 \
  "cat apps/server/src/marketdata/a.adapter.ts apps/server/src/marketdata/b.rules.ts" bash
cmd_case "多文件一条命令：两个都已标记 ⇒ 静默" d3 \
  "cat apps/server/src/marketdata/b.rules.ts apps/server/src/marketdata/a.adapter.ts" silent
cmd_case "多文件：其中一个是新的 ⇒ 仍注入" d3 \
  "cat apps/server/src/marketdata/a.adapter.ts apps/server/src/marketdata/c.port.ts" bash

echo "── fail-open ────────────────────────────────────────────────"
assert "既无 file_path 也无 command" '{"session_id":"f1","tool_input":{}}' silent
assert "畸形 JSON" 'not json at all' silent
assert "空输入" '' silent

echo
if [ "$FAILED" -eq 0 ]; then
  echo "全部通过"
else
  echo "有用例失败"
  exit 1
fi
