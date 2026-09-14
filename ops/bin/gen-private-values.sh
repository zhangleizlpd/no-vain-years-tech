#!/usr/bin/env bash
#
# 生成本机「私有业务数据清单」—— 私有数据写入闸的真值源。🚫 产物永不入仓。
#
# 本仓面向公开。券商账户号 / 成交号 / 订单号 / 真实持仓的期权合约码 / 用户手机号这类值
# 不定位任何主机，L1 结构层（判形状）与 fleet.env 派生的 L2 都抓不到；而它们一旦写进
# fixture / spec / PR 正文，就等于把真实账户再发布一遍。判据 SoT:
# docs/conventions/information-boundary.md（「真值写进仓 = 再发布一遍」）。
#
# 本脚本只写**读取逻辑**，源码里没有、也不许有任何真值 —— 把真值写进仓来做守门，等于再
# 发布一遍（同 check-identifier-boundary.ts 不内置 denylist 的理由）。
#
# 两个消费方读同一个文件、同一个 env 名 NVY_PRIVATE_VALUES_FILE：
#   · scripts/checks/check-identifier-boundary.ts   L2 规则 private-business-value（pre-commit / commit-msg / 全仓）
#   · scripts/hooks/pretooluse-private-data-guard.sh PreToolUse 写入闸（Write / Edit / 发布类 Bash）
#
# 采集来源（任一不可用 → 跳过并在输出里说明，不中断；两个都不可用 → 不覆盖旧清单，exit 1）：
#   1. 本机私有证据  docs/private/evidence/broker-account-poc/*.jsonl（local-only，只在主 checkout 里；
#                    worktree 里跑时从 git common dir 反推主 checkout）
#                    JSON 键 acc_id / card_num / uni_card_num / deal_id / order_id；code 与 combo_legs 里的期权合约码
#   2. prod 只读     经 ssh alias 进 PG 容器跑 SELECT（只读；无任何写语句）
#                    optionsdesk.broker_deal / broker_order / broker_position 的成交号 / 订单号 / 期权合约码，
#                    account.account.phone（只限 broker_connection 里出现的 account_id；完整号码，不取后四位）
#
# 收录规则（为什么这么定 —— 误报会教人忽略告警，等于把闸废掉）：
#   · 长度 < 8 的值丢弃：短数字在仓里到处都是，子串匹配无法可靠区分。
#   · 只收**期权合约码**（US|HK. + 词根 + 6 位日期 + C|P + 数字），正股代码不收 —— 正股是公开行情。
#   · 已作为**公开行情样本**存在于仓内（PUBLIC_SAMPLE_PATHS 命中）的期权合约码不收，否则会误拦正常开发。
#   · 手机号除原样外再收去掉 `+` 与去掉 `+86` 的写法 —— 真值在库里是 E.164，写进散文时常是国内 11 位。
#
# 输出只打印**各类别计数**与文件路径，永不打印值。
#
# 用法（dev 机，任一 checkout 下）:
#   ops/bin/gen-private-values.sh        # 生成 / 刷新清单
#   ops/bin/gen-private-values.sh -v     # 生成后自检：对 git ls-files 全集跑一遍 L2，只报按文件聚合的命中计数
#
# Env overrides:
#   NVY_PRIVATE_VALUES_FILE      清单路径                 (default ~/.nvy/private-values.txt)
#   NVY_BROKER_POC_EVIDENCE_DIR  证据目录                 (default <主 checkout>/docs/private/evidence/broker-account-poc)
#   PROD_SSH_ALIAS               prod ssh alias           (default mbw-staging)
#   PG_CONTAINER                 prod PG 容器名            (default nvy-tight-postgres-1)
#   SKIP_PROD                    =1 不连 prod              (default 0)
#
# 退出码: 0 = 清单已写入; 1 = 两个来源都不可用 / 写入失败; 2 = 参数错误。

set -uo pipefail # 不用 -e: 单个来源失败要降级继续，不中断

VERIFY=0
case "${1:-}" in
  -v | --verify) VERIFY=1 ;;
  -h | --help)
    sed -n '2,45p' "$0"
    exit 0
    ;;
  '') ;;
  *)
    echo "未知参数: $1（用法: $0 [-v]）" >&2
    exit 2
    ;;
esac

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${NVY_PRIVATE_VALUES_FILE:-$HOME/.nvy/private-values.txt}"
COMMON_DIR="$(git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)"
PRIMARY_ROOT="${COMMON_DIR%/.git}"
EVIDENCE_DIR="${NVY_BROKER_POC_EVIDENCE_DIR:-${PRIMARY_ROOT:-$REPO_ROOT}/docs/private/evidence/broker-account-poc}"
PROD_SSH_ALIAS="${PROD_SSH_ALIAS:-mbw-staging}"
PG_CONTAINER="${PG_CONTAINER:-nvy-tight-postgres-1}"
SKIP_PROD="${SKIP_PROD:-0}"

command -v python3 > /dev/null || {
  echo "❌ 需要 python3（解析 JSONL / 原子写入）" >&2
  exit 1
}
[[ "$PG_CONTAINER" =~ ^[A-Za-z0-9_.-]+$ ]] || {
  echo "❌ PG_CONTAINER 含非法字符" >&2
  exit 2
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ── prod 只读查询 ────────────────────────────────────────────────────────────
# `echo "SELECT …;" |` 管道形态：SQL 走 stdin 进容器里的 psql，不经 heredoc。
# 每行输出 `<类别>|<值>`（psql -At 的默认分隔符）；期权类在分析端再按形状过滤。
PROD_STATUS="skipped: SKIP_PROD=1"
if [ "$SKIP_PROD" != 1 ]; then
  SQL="SELECT 'broker-deal-id', deal_id FROM optionsdesk.broker_deal
UNION ALL SELECT 'broker-order-id', order_id FROM optionsdesk.broker_deal WHERE order_id IS NOT NULL
UNION ALL SELECT 'broker-order-id', order_id FROM optionsdesk.broker_order
UNION ALL SELECT 'option-contract-code', code FROM optionsdesk.broker_position
UNION ALL SELECT 'option-contract-code', code FROM optionsdesk.broker_deal
UNION ALL SELECT 'option-contract-code', code FROM optionsdesk.broker_order
UNION ALL SELECT 'option-contract-code', unnest(combo_leg_codes) FROM optionsdesk.broker_order
UNION ALL SELECT 'account-phone', a.phone FROM account.account a
  WHERE a.phone IS NOT NULL AND a.id IN (SELECT account_id FROM optionsdesk.broker_connection);"
  if echo "$SQL" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$PROD_SSH_ALIAS" \
    "docker exec -i $PG_CONTAINER sh -c \"psql -v ON_ERROR_STOP=1 -U \\\$POSTGRES_USER -d \\\$POSTGRES_DB -At\"" \
    > "$TMP/prod.txt" 2> "$TMP/prod.err"; then
    PROD_STATUS="ok"
  else
    # stderr 不回显：psql 报错可能带上下文行。只报退出码，排障自己手跑。
    PROD_STATUS="skipped: ssh/psql exit=$?"
    : > "$TMP/prod.txt"
  fi
fi

# ── 分析端：抽取 → 收录规则 → 排除公开样本 → 原子写入 → 只打印计数 ──────────────
python3 - "$EVIDENCE_DIR" "$TMP/prod.txt" "$PROD_STATUS" "$OUT" "$REPO_ROOT" << 'PY'
import datetime, glob, json, os, re, subprocess, sys, tempfile

evidence_dir, prod_file, prod_status, out_path, repo_root = sys.argv[1:6]

MIN_LEN = 8
CATEGORIES = [
    'broker-account-id',
    'broker-deal-id',
    'broker-order-id',
    'option-contract-code',
    'account-phone',
]
ID_KEYS = {
    'acc_id': 'broker-account-id',
    'card_num': 'broker-account-id',
    'uni_card_num': 'broker-account-id',
    'deal_id': 'broker-deal-id',
    'order_id': 'broker-order-id',
}
CODE_KEYS = ('code', 'combo_legs')
# 期权合约码形状：市场前缀 + 词根 + 6 位日期 + C|P + 行权价数字。正股代码天然落不进来。
# 用 finditer 而非全串匹配 —— 组合单的 combo_legs 是 `ComboLeg(code=…, …)` 这类包装串。
OPTION_RE = re.compile(r'(?<![A-Za-z0-9.])(?:US|HK)\.[A-Z][A-Z0-9]*\d{6}[CP]\d+')
# 082 之前就在仓里的行情面：这里出现的期权合约码是公开行情样本，不是私有持仓。
PUBLIC_SAMPLE_PATHS = [
    'apps/server/src/marketdata/',
    'apps/server/openapi.json',
    'apps/server/src/optionsdesk/optionsdesk.dto.ts',
]

found = {}  # value -> category（先到先得，跨类别去重）
dropped_short = 0


def add(category, raw):
    global dropped_short
    if raw is None or isinstance(raw, bool) or isinstance(raw, float):
        return
    v = str(raw).strip()
    if not v:
        return
    if len(v) < MIN_LEN:
        dropped_short += 1
        return
    found.setdefault(v, category)


def add_option_codes(text):
    for m in OPTION_RE.finditer(text):
        add('option-contract-code', m.group(0))


def strings_under(o):
    if isinstance(o, str):
        yield o
    elif isinstance(o, list):
        for x in o:
            yield from strings_under(x)
    elif isinstance(o, dict):
        for x in o.values():
            yield from strings_under(x)


def walk(o):
    if isinstance(o, dict):
        for k, v in o.items():
            if k in ID_KEYS and not isinstance(v, (dict, list)):
                add(ID_KEYS[k], v)
            elif k in CODE_KEYS:
                for s in strings_under(v):
                    add_option_codes(s)
            walk(v)
    elif isinstance(o, list):
        for x in o:
            walk(x)


# 1. 本机私有证据
files = sorted(glob.glob(os.path.join(evidence_dir, '*.jsonl')))
bad_lines = 0
if files:
    for f in files:
        with open(f, encoding='utf-8', errors='replace') as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    walk(json.loads(line))
                except ValueError:
                    bad_lines += 1
    evidence_status = f'ok ({len(files)} 个 jsonl{"，坏行 %d" % bad_lines if bad_lines else ""})'
else:
    evidence_status = 'skipped: 目录不存在或无 *.jsonl'

# 2. prod
prod_rows = 0
with open(prod_file, encoding='utf-8', errors='replace') as fh:
    for line in fh:
        line = line.rstrip('\n')
        if '|' not in line:
            continue
        category, value = line.split('|', 1)
        prod_rows += 1
        if category == 'option-contract-code':
            add_option_codes(value)
        elif category == 'account-phone':
            add(category, value)
            if value.startswith('+'):
                add(category, value[1:])
            if value.startswith('+86'):
                add(category, value[3:])
        elif category in CATEGORIES:
            add(category, value)

if files == [] and prod_status != 'ok':
    print('❌ 两个来源都不可用，不覆盖旧清单。', file=sys.stderr)
    print(f'   evidence: {evidence_status}', file=sys.stderr)
    print(f'   prod:     {prod_status}', file=sys.stderr)
    sys.exit(1)

# 排除公开行情样本（子串语义与消费方一致：命中即会被拦 ⇒ 命中即不收）
try:
    listed = subprocess.run(
        ['git', '-C', repo_root, 'ls-files', '-z', '--', *PUBLIC_SAMPLE_PATHS],
        check=True, capture_output=True,
    ).stdout.decode('utf-8').split('\0')
except (OSError, subprocess.CalledProcessError) as e:
    print(f'❌ git ls-files 失败，无法排除公开样本: {e}', file=sys.stderr)
    sys.exit(1)
blob_parts = []
for rel in filter(None, listed):
    p = os.path.join(repo_root, rel)
    if os.path.isfile(p):
        with open(p, encoding='utf-8', errors='replace') as fh:
            blob_parts.append(fh.read())
public_blob = '\n'.join(blob_parts)
excluded_public = 0
for v in [v for v, c in found.items() if c == 'option-contract-code']:
    if v in public_blob:
        del found[v]
        excluded_public += 1

by_cat = {c: sorted(v for v, cc in found.items() if cc == c) for c in CATEGORIES}

now = datetime.datetime.now().astimezone().isoformat(timespec='seconds')
header = [
    '# private-values.txt —— 私有业务数据清单（本机生成）',
    '# 🚫 不得入仓：不得复制进任何 tracked 文件 / commit message / PR 或 issue 正文 / 聊天正文。',
    f'# 生成时间: {now}',
    '# 生成器: ops/bin/gen-private-values.sh（改收录规则去改它，别手改本文件 —— 下次生成会覆盖）',
    f'# 来源: evidence={evidence_status}; prod={prod_status}',
    '# 类别: ' + ' / '.join(CATEGORIES),
    '# 格式: 每行一个值；"# category: <name>" 开启一个类别分段；其余 # 行是注释。',
    '# 消费方: scripts/checks/check-identifier-boundary.ts (L2 private-business-value)',
    '#         scripts/hooks/pretooluse-private-data-guard.sh (PreToolUse 写入闸)',
]
body = []
for c in CATEGORIES:
    body.append(f'# category: {c}')
    body.extend(by_cat[c])

out_dir = os.path.dirname(os.path.abspath(out_path))
os.makedirs(out_dir, mode=0o700, exist_ok=True)
fd, tmp_path = tempfile.mkstemp(dir=out_dir, prefix='.private-values.', suffix='.tmp')  # mkstemp 即 0600
try:
    with os.fdopen(fd, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(header + body) + '\n')
        fh.flush()
        os.fsync(fh.fileno())
    os.chmod(tmp_path, 0o600)
    os.replace(tmp_path, out_path)  # 同目录 rename = 原子替换，读方永远看不到半个文件
except OSError as e:
    try:
        os.unlink(tmp_path)
    except OSError:
        pass
    print(f'❌ 写入失败: {e}', file=sys.stderr)
    sys.exit(1)

print(f'✅ 已写入 {out_path}（0600）')
print(f'   来源 evidence: {evidence_status}')
print(f'   来源 prod:     {prod_status}' + (f'（{prod_rows} 行）' if prod_status == 'ok' else ''))
for c in CATEGORIES:
    print(f'   {c:<22} {len(by_cat[c])}')
print(f'   丢弃（长度 < {MIN_LEN}）     {dropped_short}')
print(f'   排除（公开行情样本）   {excluded_public}')
PY
rc=$?
[ "$rc" -eq 0 ] || exit "$rc"

[ "$VERIFY" -eq 1 ] || exit 0

# ── 自检：全仓模式跑 L2，只报 private-business-value 按文件聚合的命中计数 ─────────
# 复用检查脚本本身（同一份匹配实现），而不是在这里再写一份 —— 两份实现迟早漂移。
echo
echo "── 自检：git ls-files 全集 × 私有清单（只列文件与命中行数）"
NVY_PRIVATE_VALUES_FILE="$OUT" pnpm -C "$REPO_ROOT" exec tsx scripts/checks/check-identifier-boundary.ts \
  > "$TMP/verify.log" 2>&1
check_rc=$?
hits="$(grep -F '[private-business-value]' "$TMP/verify.log" |
  sed -E 's/^ *- \[private-business-value\] //; s/  «.*$//; s/:[0-9]+$//' |
  sort | uniq -c | sort -rn)"
if [ -z "$hits" ]; then
  if grep -q '标识符边界守门' "$TMP/verify.log"; then
    echo "✅ 0 命中（检查脚本 exit=${check_rc}；非 0 说明是别的规则红，与本清单无关）"
  else
    echo "❌ 检查脚本没有正常输出（exit=${check_rc}）—— 先确认 node_modules 已装" >&2
    exit 1
  fi
else
  printf '%s\n' "$hits"
  echo "（上表为 行数 文件；不回显值。修法：改合成值或定性表述，真值只放 docs/private/）"
fi
