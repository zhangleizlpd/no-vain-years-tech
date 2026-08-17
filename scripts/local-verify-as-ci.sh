#!/usr/bin/env bash
# 用「CI 那样干净」的环境跑一条本地验证命令。
#
#   scripts/local-verify-as-ci.sh pnpm exec nx affected -t test --base=origin/main
#   scripts/local-verify-as-ci.sh pnpm nx run server:test test/integration/xxx.it.spec.ts
#   scripts/local-verify-as-ci.sh --list          # 只列泄漏清单，不跑
#
# ── 它防的是哪一类事故 ─────────────────────────────────────────────────────
# **本地绿 / CI 红，而且差异不在代码里，在你 shell 的 env 里。**
#
# dev shell 常年带着几十个 server env（`.envrc` / direnv / 手工 export）。CI 环境是干净的。
# 于是「某个 boot-required 的 config 没人给值」这类缺陷在本地**永远看不见** —— 你的
# 真值把缺失盖住了；只有 CI 会红，而 CI 侧偏偏又最难拿到失败文本。
#
# 2026-08-17 实撞（本脚本的由来）：059 的 IT 漏了 `REDIS_URL`，`redis.config.ts` 的
# `url` 是必填 `.url()` ⇒ DI 期 ZodError ⇒ 整文件 33 个 test 全 skipped、186ms 秒炸。
# 本地四轮全绿、CI 四轮全红，**烧了四轮 CI 才定位**。而本机 `env -u REDIS_URL` 一跑
# 就复现。事后清点：这台机器泄漏了 30 个 server env。
#
# ── 判据从 .env.example 派生，不硬编码 ────────────────────────────────────
# 🚨 硬编码键表必然漂：加一个新 env、忘了同步这里，本脚本就对它失明 —— 那正是它要防的
#    那类「静默失明」。`.env.example` 是 `check-env-sync` 认的权威键清单，跟着它走。
#
# ⚠️ 它**不是** CI 的完整复刻，只覆盖「env 泄漏」这一个维度。核数 / 磁盘 / 网络 / Docker
#    资源都还是本机的。别拿它绿了当「CI 一定绿」。
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE="$REPO/apps/server/.env.example"
[[ -f "$EXAMPLE" ]] || { echo "❌ 找不到 $EXAMPLE —— 键清单的来源没了，本脚本需同步" >&2; exit 2; }

# 权威键清单 = .env.example 里所有赋值行的键名。
# ⚠️ 不用 `mapfile` —— 那是 bash 4+，macOS 自带 3.2，dev 机上会直接 command not found。
KEYS=()
while IFS= read -r k; do
  KEYS+=("$k")
done < <(grep -oE '^[A-Z][A-Z0-9_]*=' "$EXAMPLE" | tr -d '=' | sort -u)
[[ ${#KEYS[@]} -gt 0 ]] || { echo "❌ 从 $EXAMPLE 一个键都没解析出来 —— 格式变了" >&2; exit 2; }

# 只报告 / 只 unset **本机真有值**的那些：清单是全集，泄漏才是要治的
leaked=()
for k in "${KEYS[@]}"; do
  [[ -n "${!k:-}" ]] && leaked+=("$k")
done

printf '本机泄漏的 server env: %d / %d 个（清单源: apps/server/.env.example）\n' \
  "${#leaked[@]}" "${#KEYS[@]}"
# ⚠️ `${arr[*]}` 在空数组 + `set -u` 下于 bash 3.2 会报 unbound，故必须先判长度
if [[ ${#leaked[@]} -gt 0 ]]; then
  printf '  %s\n' "${leaked[*]}"
fi

if [[ "${1:-}" == "--list" ]]; then
  exit 0
fi
[[ $# -gt 0 ]] || { echo "用法: $0 <command...>   或   $0 --list" >&2; exit 2; }

# 没有泄漏时 env -u 也无害，照跑，省一个分支
unset_args=()
for k in "${leaked[@]}"; do unset_args+=(-u "$k"); done

echo "── 以干净环境执行: $* ──"
exec env "${unset_args[@]}" "$@"
