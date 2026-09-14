#!/usr/bin/env bash
# 对照表测试：pretooluse-private-data-guard.sh
# 用法: bash scripts/hooks/pretooluse-private-data-guard.test.sh scripts/hooks/pretooluse-private-data-guard.sh
#
# 断言：① 拦截臂 exit 2 + stdout deny JSON + stderr 有原因 ② 放行臂 exit 0 + stdout 空
# ③ **所有臂** stdout / stderr 都不含清单里的值（报告本身不能成为泄漏渠道）。
#
# 全部值是合成的，清单经 NVY_PRIVATE_VALUES_FILE 指向临时文件。
# 「仓内未忽略路径」取本仓真实路径（文件不必存在）；「被忽略路径」取 docs/private/ 下（.gitignore 已登记）；
# 「仓外路径」取临时目录。
#
# 🚨 JSON 夹具一律由 jq `--arg` 生成，不手写 —— 手写转义坏掉时 hook 按 fail-open 放行，
# 表现与「hook 漏判」完全同形（pretooluse-comment-provenance.test.sh 实撞过）。
#
# 第一个参数就是被测 hook 路径 ⇒ 定向变异时传一份改坏的拷贝即可，不必动真实文件。
set -u

SCRIPT="${1:?usage: $0 <hook-script>}"
JQ=/usr/bin/jq
REPO=$(cd "$(dirname "$0")/../.." && pwd)
TESTTMP=$(mktemp -d)
trap 'rm -rf "$TESTTMP"' EXIT
FAILED=0

FAKE_ORDER='SYNTH-ORDER-ID-000042'
FAKE_CODE='US.ZZZZ991231C123000'
SHORT='short7x'
LIST="$TESTTMP/private-values.txt"
# 空行 / 注释行 / 短值刻意都在：空行若进了 grep -f 就「匹配一切」，放行臂会全红
printf '%s\n' '# 合成清单' '' '# category: broker-order-id' "$FAKE_ORDER" \
  '# category: option-contract-code' "$FAKE_CODE" '# category: account-phone' "$SHORT" '' > "$LIST"

IN_REPO="$REPO/apps/server/src/optionsdesk/__synthetic_guard_probe__.spec.ts"
IGNORED="$REPO/docs/private/evidence/__synthetic_guard_probe__.md"
OUTSIDE="$TESTTMP/scratch/note.md"
printf '订单 %s 的对账\n' "$FAKE_ORDER" > "$TESTTMP/body-hit.md"
printf '改用合成值，定性表述\n' > "$TESTTMP/body-clean.md"
printf 'fix(optionsdesk): 合约 %s\n' "$FAKE_CODE" > "$TESTTMP/msg-hit.txt"

# $1 = 臂名；$2 = hook 输入 JSON；$3 = block | allow；$4 = 清单路径（缺省 $LIST）
assert() {
  local name=$1 json=$2 want=$3 list=${4:-$LIST} code out err got
  out=$(printf '%s' "$json" | NVY_PRIVATE_VALUES_FILE="$list" bash "$SCRIPT" 2> "$TESTTMP/err")
  code=$?
  err=$(cat "$TESTTMP/err")
  case "$code" in
    2) got=block ;;
    0) got=allow ;;
    *) got="exit=${code}" ;;
  esac
  if printf '%s\n%s' "$out" "$err" | grep -qF -e "$FAKE_ORDER" -e "$FAKE_CODE"; then
    echo "❌ $name — 输出回显了清单里的值"
    FAILED=1
    return
  fi
  if [ "$got" != "$want" ]; then
    echo "❌ $name — 期望 ${want}，实际 ${got}"
    [ -n "$err" ] && printf '     stderr: %s\n' "$err"
    FAILED=1
    return
  fi
  if [ "$want" = block ]; then
    if ! printf '%s' "$out" | "$JQ" -e '.hookSpecificOutput.permissionDecision == "deny"' > /dev/null 2>&1; then
      echo "❌ $name — 拦截时 stdout 应为 deny JSON，实际: ${out:-<empty>}"
      FAILED=1
      return
    fi
    if ! printf '%s' "$err" | grep -qF '命中' || ! printf '%s' "$err" | grep -qF 'docs/private/'; then
      echo "❌ $name — 拦截时 stderr 应说明命中与去处，实际: ${err:-<empty>}"
      FAILED=1
      return
    fi
  elif [ -n "$out" ]; then
    echo "❌ $name — 放行时 stdout 应为空，实际: $out"
    FAILED=1
    return
  fi
  echo "✅ $name"
}

write_json() { "$JQ" -n --arg f "$1" --arg c "$2" '{tool_name:"Write",tool_input:{file_path:$f,content:$c}}'; }
edit_json() {
  "$JQ" -n --arg f "$1" --arg o "$2" --arg n "$3" \
    '{tool_name:"Edit",tool_input:{file_path:$f,old_string:$o,new_string:$n}}'
}
bash_json() { "$JQ" -n --arg c "$1" --arg d "$REPO" '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}'; }

echo "── Write / Edit ───────────────────────────────────────────────"
assert "Write 仓内未忽略路径含清单值 ⇒ 拦" "$(write_json "$IN_REPO" "const id = '${FAKE_ORDER}';")" block
assert "Write 仓内未忽略路径、内容干净 ⇒ 放行" "$(write_json "$IN_REPO" "const id = 'SYNTH-PLACEHOLDER';")" allow
assert "Write 被 gitignore 的 docs/private ⇒ 放行" "$(write_json "$IGNORED" "合约 ${FAKE_CODE}")" allow
assert "Write 仓外路径 ⇒ 放行" "$(write_json "$OUTSIDE" "合约 ${FAKE_CODE}")" allow
assert "Edit new_string 含清单值 ⇒ 拦" "$(edit_json "$IN_REPO" "old" "legs: ['${FAKE_CODE}']")" block
assert "Edit 只在 old_string 里（正在删掉真值）⇒ 放行" "$(edit_json "$IN_REPO" "'${FAKE_CODE}'" "'SYNTH'")" allow
assert "清单里短于 8 的值不参与匹配 ⇒ 放行" "$(write_json "$IN_REPO" "const t = '${SHORT}';")" allow

echo "── Bash：发布类 ───────────────────────────────────────────────"
assert "gh-bot pr create --body-file <含清单值文件> ⇒ 拦" \
  "$(bash_json "/Users/x/.nvy/bin/gh-bot pr create --repo o/r --base main --title t --body-file $TESTTMP/body-hit.md")" block
assert "gh-bot pr create --body-file <干净文件> ⇒ 放行" \
  "$(bash_json "~/.nvy/bin/gh-bot pr create --title t --body-file $TESTTMP/body-clean.md")" allow
assert "gh pr comment --body 含清单值 ⇒ 拦" "$(bash_json "gh pr comment 12 --body \"订单 ${FAKE_ORDER}\"")" block
assert "git commit -m 含清单值 ⇒ 拦" "$(bash_json "git add -A && git commit -m \"fix: 合约 ${FAKE_CODE}\"")" block
assert "git-bot commit -F <含清单值文件> ⇒ 拦" "$(bash_json "~/.nvy/bin/git-bot commit -F $TESTTMP/msg-hit.txt")" block
assert "git commit heredoc 含清单值 ⇒ 拦" "$(bash_json "git commit -F - <<'EOF'
fix: 订单 ${FAKE_ORDER}
EOF")" block
assert "gh-bot api PATCH -F body=@<含清单值文件> ⇒ 拦" \
  "$(bash_json "gh-bot api -X PATCH repos/o/r/pulls/1 -f title=t -F body=@$TESTTMP/body-hit.md")" block

echo "── Bash：写仓类 ───────────────────────────────────────────────"
assert "heredoc 重定向写仓内未忽略路径 ⇒ 拦" "$(bash_json "cat > apps/server/src/x.ts <<'EOF'
const c = '${FAKE_CODE}';
EOF")" block
assert "tee 写仓内未忽略路径 ⇒ 拦" "$(bash_json "echo ${FAKE_ORDER} | tee -a apps/server/src/y.ts")" block
assert "heredoc 重定向写 docs/private ⇒ 放行" "$(bash_json "cat > docs/private/evidence/n.md <<'EOF'
${FAKE_CODE}
EOF")" allow

echo "── Bash：只读 / 取数类一律放行 ─────────────────────────────────"
assert "ssh … psql 查询（SQL 里有清单值）⇒ 放行" \
  "$(bash_json "echo \"SELECT * FROM optionsdesk.broker_order WHERE order_id='${FAKE_ORDER}';\" | ssh mbw-staging 'docker exec -i nvy-tight-postgres-1 sh -c \"psql -At\"'")" allow
assert "查询结果重定向到仓外 + 2>&1 ⇒ 放行" "$(bash_json "rg -n ${FAKE_CODE} apps/ > /tmp/hits.txt 2>&1")" allow
assert "git log --grep 不是 commit ⇒ 放行" "$(bash_json "git log --oneline --grep ${FAKE_ORDER}")" allow
assert "gh pr view 不是发布 ⇒ 放行" "$(bash_json "gh-bot pr view 12 --json body | grep ${FAKE_ORDER}")" allow

echo "── fail-open ──────────────────────────────────────────────────"
assert "清单缺失 ⇒ 放行" "$(write_json "$IN_REPO" "const id = '${FAKE_ORDER}';")" allow "$TESTTMP/no-such-list.txt"
assert "清单缺失时发布命令 ⇒ 放行" "$(bash_json "git commit -m \"${FAKE_ORDER}\"")" allow "$TESTTMP/no-such-list.txt"
assert "畸形 JSON ⇒ 放行" 'not json at all' allow
assert "空输入 ⇒ 放行" '' allow
assert "既无 file_path 也无 command ⇒ 放行" '{"tool_name":"Write","tool_input":{}}' allow

echo
if [ "$FAILED" -eq 0 ]; then
  echo "全部通过"
else
  echo "有用例失败"
  exit 1
fi
