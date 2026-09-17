#!/usr/bin/env bash
# 对照表测试：posttooluse-steering-density.sh
# 用法: bash scripts/hooks/posttooluse-steering-density.test.sh scripts/hooks/posttooluse-steering-density.sh
#
# 断言四类：① 超线臂注入提醒且计数逐字对上 ② 静默臂零输出（线内 / 非 specs 路径 / spec.md 只有 FR 行的 MUST）
# ③ 去重（同 session 同计数第二次静默；计数变了再提醒）④ 全部臂 exit 0（fail-open，含坏 JSON / 文件不存在）。
# 夹具全部合成、写在 $TESTTMP 下的假 specs/ 目录；JSON 一律 jq --arg 生成，不手写。
# 计数错法双向都不报错：多数了 = 刷屏成墙纸，少数了 = 079 那种 35 个 🚫 照旧静默 —— 所以计数要逐字断言。
set -u

SCRIPT="${1:?usage: $0 <hook-script>}"
JQ=/usr/bin/jq
GREP=/usr/bin/grep
FAILED=0
# 隔离 TMPDIR：hook 的去重 marker 落在 $TMPDIR 下，跟真实 session 共用会让去重臂随残留变绿变红。
TESTTMP=$(mktemp -d)
trap 'rm -rf "$TESTTMP"' EXIT
FIX="$TESTTMP/repo/specs/999-fixture"
mkdir -p "$FIX" "$TESTTMP/repo/docs/notes"

mkjson() { "$JQ" -n --arg fp "$1" --arg sid "$2" '{session_id:$sid, tool_name:"Write", tool_input:{file_path:$fp}}'; }

OUT=""; CODE=0
run() {
  OUT=$(printf '%s' "$1" | TMPDIR="$TESTTMP" bash "$SCRIPT" 2>/dev/null)
  CODE=$?
}

assert_warn() { # name json expected-substring
  run "$2"
  if [ "$CODE" -ne 0 ]; then
    echo "❌ $1 — exit=${CODE}（fail-open 契约要求恒 0）"; FAILED=1; return
  fi
  if printf '%s' "$OUT" | "$GREP" -q -F -- "$3"; then
    echo "✅ $1"
  else
    echo "❌ $1 — 应注入提醒且含「$3」，实际: ${OUT:-<empty>}"; FAILED=1
  fi
}

assert_silent() { # name json
  run "$2"
  if [ "$CODE" -ne 0 ]; then
    echo "❌ $1 — exit=${CODE}（fail-open 契约要求恒 0）"; FAILED=1; return
  fi
  if [ -z "$OUT" ]; then
    echo "✅ $1"
  else
    echo "❌ $1 — 应静默，实际: $OUT"; FAILED=1
  fi
}

# ── 夹具 ────────────────────────────────────────────────────────────────
# 超线 plan：🚫×4 🚨×3 ⚠️×2 + MUST NOT + NEVER = 11；MUSTARD / mustn't / 绝对值 都不该算。
cat >"$FIX/plan.md" <<'MD'
# plan
- 🚫 不删、🚫 不撤销确认、🚫 逐事件一条、🚫 计失败
- 🚨 反例臂一 · 🚨 反例臂二 · 🚨 反例臂三
- ⚠️ 绊线 · ⚠️ 未验证
- 新增的 query 参数 MUST NOT 成为第二条数据路径；NEVER 单行 FOR UPDATE
- MUSTARD 与 mustn't 与 绝对值 不算
MD
# 线内 plan：恰好 10 个（预算 ≤ 10 不提醒）
cat >"$FIX/tasks.md" <<'MD'
- 🚫 a 🚫 b 🚫 c 🚫 d 🚫 e
- 🚨 f 🚨 g 🚨 h 🚨 i 🚨 j
MD
# spec：15 行 FR 的 MUST 不计 + 2 个 🚫 ⇒ 2，静默
{
  i=1; while [ "$i" -le 15 ]; do printf -- '- **FR-%03d**: System MUST do thing %d\n' "$i" "$i"; i=$((i+1)); done
  printf -- '- **SC-001**: System MUST NOT regress\n'
  printf -- "- '状态 -> 🚫 混入求和; 🚫 跳变'\n"
} >"$FIX/spec.md"
# spec：散文里 11 个无编号 MUST ⇒ 超线
{
  i=1; while [ "$i" -le 11 ]; do printf -- '- Acceptance: the screen MUST show %d\n' "$i"; i=$((i+1)); done
} >"$FIX/checklist-spec.md"
mkdir -p "$TESTTMP/repo/specs/998-x"; cp "$FIX/checklist-spec.md" "$TESTTMP/repo/specs/998-x/spec.md"
# 非 specs 路径：20 个标记也静默
printf '🚫%.0s' 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 >"$TESTTMP/repo/docs/notes/plan.md"

# ── ① 超线臂 ────────────────────────────────────────────────────────────
J_OVER=$(mkjson "$FIX/plan.md" s1)
assert_warn "超线 plan 注入提醒" "$J_OVER" "标记预算提醒 — specs/999-fixture/plan.md 现有 11 个强调标记，预算 ≤ 10"
# 计数断言换一个 session_id，免得撞上一条的去重槽。
assert_warn "计数逐字（🚫4 🚨3 ⚠️2 大写2 中文0）" "$(mkjson "$FIX/plan.md" s1b)" "🚫 4 · 🚨 3 · ⚠️ 2 · 大写指令词（MUST / NEVER / CRITICAL 一族）2 · 严禁 / 绝对禁止 0"
assert_warn "spec 散文里 11 个无编号 MUST 超线" "$(mkjson "$TESTTMP/repo/specs/998-x/spec.md" s2)" "大写指令词（MUST / NEVER / CRITICAL 一族）11"
OUT=$(printf '%s' "$(mkjson "$FIX/tasks.md" s3)" | TMPDIR="$TESTTMP" NVY_STEERING_BUDGET=5 bash "$SCRIPT" 2>/dev/null)
if printf '%s' "$OUT" | "$GREP" -q -F "现有 10 个强调标记，预算 ≤ 5"; then echo "✅ 预算可由 NVY_STEERING_BUDGET 覆盖"; else echo "❌ 预算覆盖失败: ${OUT:-<empty>}"; FAILED=1; fi

# ── ② 静默臂 ────────────────────────────────────────────────────────────
assert_silent "线内（恰好 10 个）静默" "$(mkjson "$FIX/tasks.md" s4)"
assert_silent "spec 的 FR/SC 行 MUST 不计 ⇒ 静默" "$(mkjson "$FIX/spec.md" s5)"
assert_silent "非 specs 路径静默" "$(mkjson "$TESTTMP/repo/docs/notes/plan.md" s6)"
assert_silent "specs 下非产物文件名（checklist-spec.md）静默" "$(mkjson "$FIX/checklist-spec.md" s7)"

# ── ③ 去重 ──────────────────────────────────────────────────────────────
J_D=$(mkjson "$FIX/plan.md" dedup)
assert_warn "去重臂首发提醒" "$J_D" "现有 11 个"
assert_silent "同 session 同计数第二次静默" "$J_D"
printf -- '- 🚫 再加一个\n' >>"$FIX/plan.md"
assert_warn "计数变了（12）再提醒" "$J_D" "现有 12 个"
assert_silent "同计数（12）第三次静默" "$J_D"

# ── ④ fail-open ──────────────────────────────────────────────────────────
assert_silent "坏 JSON 静默放行" "{not json"
assert_silent "文件不存在静默放行" "$(mkjson "$FIX/nope/plan.md" s8)"
assert_silent "无 file_path 静默放行" "$("$JQ" -n '{session_id:"s9", tool_name:"Bash", tool_input:{command:"ls"}}')"

if [ "$FAILED" -eq 0 ]; then echo "ALL PASS"; exit 0; else echo "FAILED"; exit 1; fi
