#!/usr/bin/env bash
# 反例/正例对照表 — 期望值写死，任一不符即非零退出
G="$1"; fails=0
t(){ r=$(/usr/bin/jq -n --arg c "$2" '{tool_input:{command:$c}}' | bash "$G")
     [ -z "$r" ] && v=ALLOW || v=DENY
     if [ "$v" = "$3" ]; then printf '  ok   %-8s %s\n' "$v" "$1"
     else printf '  FAIL got=%-6s want=%-6s %s\n' "$v" "$3" "$1"; fails=$((fails+1)); fi; }

echo "— 反例（跑了必红/必骗人，且看不出根因）"
t "vitest --root"             "pnpm exec vitest --root apps/server foo.it.spec.ts" DENY

echo "— 反例：管道吞掉退出码与失败证据（2026-08-02 新增，作者本人踩中）"
t "nx test | tail"            "pnpm exec nx test server | tail -30" DENY
t "nx affected 2>&1 | tail"   "pnpm exec nx affected -t lint typecheck test build runtime-smoke --base=origin/main 2>&1 | tail -40" DENY
t "nx lint | head"            "pnpm exec nx lint server | head -5" DENY
t "pnpm -C 包裹 + | tail"      "pnpm -C /repo exec nx test server 2>&1 | tail -20" DENY

echo "— 正例（正常用法，不许误伤）"
# 🚨 承重回归: 续行折叠。segment 循环按行读, 不先折叠续行就会把前缀与 runner 切成两段。
t "续行写法"                   "$(printf 'NX_DAEMON=false \\\n  pnpm exec nx test server')" ALLOW
t "全量落盘（推荐替代写法）"     "pnpm exec nx test server > /tmp/v.log 2>&1; echo EXIT=\$?" ALLOW
t "nx lint server"            "NX_DAEMON=false pnpm exec nx lint server" ALLOW
t "nx test mobile"            "pnpm exec nx test mobile" ALLOW
t "runtime-smoke"             "pnpm exec nx run mobile:runtime-smoke" ALLOW
t "git status"                "git status --short" ALLOW

echo "— 正例：管道规则只管「跑 target 的 nx」，分析端截断与查询类不受限"
t "rg 接 head（分析端截断）"    "rg -n 'Failed tasks' /tmp/v.log | head -5" ALLOW
t "nx show 接 head（查询类）"   "pnpm exec nx show projects | head -5" ALLOW
t "nx test 接 rg（不截断）"     "pnpm exec nx test server 2>&1 | rg 'Failed tasks'" ALLOW

echo "— 回归：已删规则不得复活（2026-08-02 证伪 / 不可复现 / 已被结构化取代，详见 guard 顶部 🧟 段）"
# env 已烘进属主(project.json options.env / real-backend-harness.ts) → 再拦就是误伤
t "export-openapi 裸跑"        "pnpm exec nx run server:export-openapi" ALLOW
t "contract-smoke 裸跑"        "pnpm exec tsx e2e/contract-smoke/run.ts" ALLOW
t "pnpm -C 包裹 export-openapi" "pnpm -C apps/server exec nx run server:export-openapi" ALLOW
t "server IT 裸跑（rule 已删）"  "pnpm exec nx test server test/integration/foo.it.spec.ts" ALLOW
t "affected 含 test 裸跑"       "NX_DAEMON=false pnpm exec nx affected -t lint typecheck test build --base=origin/main" ALLOW
t "无 DATABASE_URL/REDIS_URL"   "MARKETDATA_PROVIDER=mock pnpm exec nx test server" ALLOW
t "完全不 unset OSS"            "DATABASE_URL='x' REDIS_URL='y' pnpm exec nx test server" ALLOW
t "OSS 只 unset 一半"           "env -u OSS_ACCESS_KEY_ID -u OSS_ACCESS_KEY_SECRET pnpm exec nx test server" ALLOW

echo "— 回归：整条命令子串匹配会误伤的两类（2026-08-02 guard 拦住作者本人）"
t "prose: commit 含 test server"    "git commit -m 'test server refactor'" ALLOW
t "prose: commit 含 contract-smoke" "git commit -m 'add contract-smoke case'" ALLOW
t "prose: grep export-openapi"      "grep -rn export-openapi docs/" ALLOW
t "引号内 | 切出 vitest 片段"        "grep -n 'env -u OSS\\|export-openapi\\|vitest --root' docs/conventions/x.md" ALLOW
t "runner 一段 + 标记在另一段"       "pnpm exec nx lint server && grep -rn 'test server' docs/" ALLOW

echo "— fail-open"
r=$(printf 'not json' | bash "$G"); [ -z "$r" ] && echo "  ok   坏 JSON → ALLOW" || { echo "  FAIL 坏 JSON 应 ALLOW"; fails=$((fails+1)); }
r=$(printf '{}' | bash "$G");      [ -z "$r" ] && echo "  ok   空 payload → ALLOW" || { echo "  FAIL 空 payload 应 ALLOW"; fails=$((fails+1)); }

echo; [ "$fails" = 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
