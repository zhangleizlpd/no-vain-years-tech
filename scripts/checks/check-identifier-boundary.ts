/**
 * 标识符边界守门 —— 判据 SoT: docs/conventions/information-boundary.md
 *
 * 本仓面向公开。仓内只许出现**代号**；能定位到一台真机 / 一个云账号的字符串必须
 * 出仓（运行时从 fleet.env 解析）。gitleaks 覆盖不到这一层 —— 裸 IP / 云账号 UID /
 * 实例 ID 都没有熵特征，内置规则集里没有对应 rule（per ADR-0037 §1）。
 *
 * 两层，承重的那层不需要知道任何真值：
 *
 *   L1 结构层  判**形状**。CI 每个 PR 无条件跑。不读 fleet.env，因此在 CI / 新 clone
 *              上同样有效 —— 这是它承重的原因。
 *   L2 值层    从 ~/.nvy/fleet.env 的值**派生**精确字面量。只在 dev 机 pre-commit 生效，
 *              纯纵深防御。仓内**不内置 denylist** —— 把真标识符写进仓来做守门等于
 *              再发布一遍。
 *
 * 三条设计纪律（每条都有反例撑着，详见 convention）：
 *   1. L1 必须在 CI —— 只挂本地钩子的守门在 CI 上永远 skip，而 CI 才是唯一拦得住 PR
 *      的路径（本地钩子还结构性可被 `--no-verify` 绕过）。
 *   2. **采集端全开**：扫 `git ls-files` 全集，零 skip-dirs。反例：仓内曾给文件树扫描器
 *      配 `skip-dirs: docs,...`，而 docs/ 正是所有标识符的所在地 —— 采集端一加 filter，
 *      反例就永远看不见。过滤只在分析端（allowlist）做。
 *   3. allowlist 登记「**已知良性**」而非已知恶性，且**只按值、不按路径**。按路径豁免是
 *      gitleaks 那条教训的复现：path 命中即整个文件跳过，等于放过该文件里任何 finding。
 *
 * 已知覆盖不到的三处（明说而非掩盖）：
 *   · **二进制文件**（截图等）—— 正则无从下手。「像素里的 PII」没有任何扫描器能抓，
 *     这正是 specs/*&#47;design/ 整体不入库的原因（.gitignore + sdd-authoring rule）。
 *   · **PR body** —— 无 git 侧钩子能看到，只能靠 CI 读 PR 事件体。
 *   · **`git commit --no-verify`** —— 本地钩子结构性可绕，靠 CI 那一层兜。
 *
 * 复杂度：O(N × M)，N = tracked 文件字节总数，M = 规则数（常数 6）。即单遍线性扫描。
 *
 * 用法:
 *   pnpm tsx scripts/checks/check-identifier-boundary.ts                 # 全仓（CI）
 *   pnpm tsx scripts/checks/check-identifier-boundary.ts --staged        # 暂存区（pre-commit，含 L2）
 *   pnpm tsx scripts/checks/check-identifier-boundary.ts --commit-msg F  # commit message
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 单文件读取上限。超限直接跳 —— readFileSync(…,'utf8') 超 V8 字符串上限会抛，
 *  抛出去会把整轮扫描带走（同 check-scheduled-tasks.ts 的处理）。 */
const MAX_FILE_BYTES = 2_000_000;

/** 二进制扩展名：正则对其无意义，且读成 utf8 会产生噪声匹配。见文件头「已知覆盖不到」。 */
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|tgz|bz2|xz|7z|jar|apk|aab|ipa|jks|keystore|p12|woff2?|ttf|otf|eot|mp[34]|mov|wav|xdb|db|sqlite3?|bin|so|dylib|dll|node)$/i;

/** hex32 规则的适用面：部署 / 配置 / 主机侧。别处 32 位 hex 多是 md5 / 完整性摘要。
 *  这是**规则的适用范围**，不是采集端 filter —— 采集仍是全集（纪律 2）。 */
const HEX32_SURFACE = /^(\.github\/|ops\/|services\/|docker-compose|\.env|scripts\/)/;

export interface Finding {
  file: string;
  line: number;
  rule: string;
  snippet: string;
  hint: string;
}

export interface Allowlist {
  /** 已知良性的整值。键 = 规则 id。 */
  values: Record<string, string[]>;
}

export const EMPTY_ALLOWLIST: Allowlist = { values: {} };

// ─────────────────────────────────────────────────────────────────────────────
// IPv4：结构性排除用**八位组数值比较**表达，刻意不写点分字面量
// —— 否则本文件自己就会被自己命中（自指陷阱）。所有区间均为 RFC 事实，永久耐久。
// ─────────────────────────────────────────────────────────────────────────────

/** 非公网 / 文档保留 / 基准测试保留 → 结构性良性，无需登记 allowlist。 */
export function isNonPublicIpv4(a: number, b: number, c: number, d: number): boolean {
  if ([a, b, c, d].some((o) => o > 255)) return true; // 不是合法 IPv4（版本号等）
  if (a === 0 || a === 127) return true; // 「本网络」/ loopback
  if (a === 10) return true; // RFC1918
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 169 && b === 254) return true; // link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC6598 CGNAT 共享段
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // RFC6890 / RFC5737 doc
  if (a === 198 && (b === 18 || b === 19)) return true; // RFC2544 基准测试
  if (a === 198 && b === 51 && c === 100) return true; // RFC5737 doc
  if (a === 203 && b === 0 && c === 113) return true; // RFC5737 doc
  if (a >= 224) return true; // 组播 + 保留
  return false;
}

/** 前后不许紧邻数字或点 —— 杀掉 5 段以上的点分序列（章节号 `§ 5.3.15.8.2` 那类）。 */
const IPV4_RE = /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d.])/g;

const RULES: {
  id: string;
  hint: string;
  scan: (line: string, relPath: string) => string[];
}[] = [
  {
    id: 'public-ipv4',
    hint: '公网 IP → 出仓，改用代号 + ${NVY_*_SSH} / ${NVY_*_HOST}（ops/host/fleet.env.example）',
    scan: (line) => {
      const hits: string[] = [];
      for (const m of line.matchAll(IPV4_RE)) {
        const [a, b, c, d] = [m[1], m[2], m[3], m[4]].map(Number);
        if (!isNonPublicIpv4(a, b, c, d)) hits.push(m[0]);
      }
      return hits;
    },
  },
  {
    id: 'cloud-instance-id',
    hint: '云主机实例 ID → 出仓，进 fleet.env（如 NVY_QUANT_WIN_ECS_ID）',
    scan: (line) => [...line.matchAll(/\bi-[0-9a-z]{16,22}\b/g)].map((m) => m[0]),
  },
  {
    id: 'registry-instance-id',
    hint: '镜像仓实例 ID → 出仓，整串走 ${NVY_ACR_REPO} / secrets.ACR_REGISTRY',
    scan: (line) => [...line.matchAll(/\bcrpi-[0-9a-z]{12,20}\b/g)].map((m) => m[0]),
  },
  {
    id: 'network-resource-id',
    hint: 'VPC / vSwitch / 安全组 / ENI / NAT / EIP 资源 ID → 出仓，属私有散文（host-inventory）',
    scan: (line) =>
      [...line.matchAll(/\b(?:vpc|vsw|sg|eni|nat|eip)-[0-9a-z]{12,22}\b/g)].map((m) => m[0]),
  },
  {
    id: 'cloud-account-uid',
    hint: '16 位裸数字疑似云账号 UID → 出仓；确属业务 ID / 语言常量则登记 allowlist 并写理由',
    // 边界写法结构性消掉两整类假阳性，而不是逐个登记 allowlist：
    //   `(?<![\w.])` → 小数尾数（`0.3377492957220201` 的小数部分恰好 16 位）
    //                + 长标识符内嵌数字（`oMOCKDEV0000000000000000abcd`）
    //   `(?!\w)`     → 同上的后缀侧；刻意**不**含 `.`，好让句末带句点的真 UID 仍被抓到
    scan: (line) => [...line.matchAll(/(?<![\w.])\d{16}(?!\w)/g)].map((m) => m[0]),
  },
  {
    id: 'hex32-account-id',
    hint: '32 位 hex 疑似 CDN / DNS 账号 ID → 出仓走 repo secrets',
    scan: (line, relPath) =>
      HEX32_SURFACE.test(relPath) ? [...line.matchAll(/\b[0-9a-f]{32}\b/g)].map((m) => m[0]) : [],
  },
];

/** 分析端：单文件扫描。采集端的「全开」由调用方保证。 */
export function scanText(relPath: string, text: string, allow: Allowlist): Finding[] {
  const findings: Finding[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const rule of RULES) {
      for (const hit of rule.scan(lines[i], relPath)) {
        if (allow.values[rule.id]?.includes(hit)) continue;
        findings.push({
          file: relPath,
          line: i + 1,
          rule: rule.id,
          snippet: hit,
          hint: rule.hint,
        });
      }
    }
  }
  return findings;
}

export function scanFiles(files: Record<string, string>, allow: Allowlist): Finding[] {
  return Object.entries(files).flatMap(([p, t]) => scanText(p, t, allow));
}

/**
 * fleet.env 里**不是标识符**的键 —— L2 不据其派生。
 *
 * 这两类当初被误划进「仓外解析」层，2026-08-08 首次启用 L2 时立刻暴露：它们制造了
 * 85 处假阳性，而假阳性会教人忽略 L2 告警，等于把这一层废掉。判断依据：
 *
 * · `_REPO_DIR` —— 主机上的**文件系统路径**。systemd `WorkingDirectory=` 必须是字面量，
 *   env 化不了；且知道仓在哪个目录对攻击者零增益（没有访问权时它什么也不是）。
 * · `_SSH_ALIAS` —— ssh alias **本身就是一种代号**，本仓的私有主机清单里就写着
 *   「活文档首现处补别名」——别名本来就是给公开面用的称呼。有识别性的是
 *   alias → IP 的**映射**，不是 alias 本身。
 *
 * 它们仍留在 fleet.env / fleet.env.example 里，因为脚本引用它们很方便；只是不参与
 * L2 派生。判据见 docs/conventions/information-boundary.md § 三层归属。
 */
const NON_IDENTIFIER_KEY = /_SSH_ALIAS$|_REPO_DIR$/;

/** L2：从 fleet.env 的**值**派生字面量。仓内不留 denylist，值只在仓外。 */
export function deriveValueLiterals(fleetEnv: string): string[] {
  const out = new Set<string>();
  for (const raw of fleetEnv.split('\n')) {
    const m = raw.match(/^\s*(NVY_[A-Z0-9_]+)\s*=\s*(.+?)\s*$/);
    if (!m) continue;
    if (NON_IDENTIFIER_KEY.test(m[1])) continue;
    const val = m[2].replace(/^["']|["']$/g, '');
    if (!val || val.startsWith('#') || val.startsWith('<')) continue;
    // 结构性兜底：绝对路径永不是标识符（键名兜不住时靠值形状再拦一道）
    if (val.startsWith('/')) continue;
    out.add(val);
    // user@host / host:port → 也提取宿主部分，命中面更宽
    const host = val.replace(/^[^@]*@/, '').replace(/:.*$/, '');
    if (host && host !== val) out.add(host);
  }
  return [...out].filter((v) => v.length >= 4);
}

export function scanForValues(files: Record<string, string>, literals: string[]): Finding[] {
  const findings: Finding[] = [];
  for (const [p, text] of Object.entries(files)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      for (const lit of literals) {
        if (lines[i].includes(lit)) {
          findings.push({
            file: p,
            line: i + 1,
            rule: 'fleet-value-leak',
            snippet: '<redacted — 命中 fleet.env 里的真值>',
            hint: '这一行含 fleet.env 的真值 → 改用 ${NVY_*} 或代号',
          });
        }
      }
    }
  }
  return findings;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ALLOWLIST_REL = 'ops/host/identifier-allowlist.json';

function loadAllowlist(): Allowlist {
  const p = join(REPO_ROOT, ALLOWLIST_REL);
  if (!existsSync(p)) return EMPTY_ALLOWLIST;
  const raw = JSON.parse(readFileSync(p, 'utf8')) as {
    rules?: Record<string, { value: string; reason: string }[]>;
  };
  const values: Record<string, string[]> = {};
  for (const [rule, entries] of Object.entries(raw.rules ?? {})) {
    values[rule] = entries.map((e) => e.value);
  }
  return { values };
}

/** 采集端：`git ls-files` 全集，**零 skip-dirs**（纪律 2）。 */
export function trackedPaths(): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
}

function readAll(paths: string[]): Record<string, string> {
  const files: Record<string, string> = {};
  for (const rel of paths) {
    if (BINARY_EXT.test(rel)) continue;
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) continue;
    if (statSync(abs).size > MAX_FILE_BYTES) continue;
    files[rel] = readFileSync(abs, 'utf8');
  }
  return files;
}

function report(findings: Finding[], scope: string, l2: 'on' | 'off'): void {
  if (findings.length === 0) {
    console.log(
      `✅ 标识符边界守门通过（${scope}，L1 结构层${l2 === 'on' ? ' + L2 值层' : '；L2 值层未启用（未找到 ~/.nvy/fleet.env —— CI 上即此态）'}）。`,
    );
    return;
  }
  console.error('❌ 标识符边界守门失败 —— 下列内容不能进公开仓：\n');
  for (const f of findings) {
    console.error(`  - [${f.rule}] ${f.file}:${f.line}  «${f.snippet}»`);
    console.error(`      ${f.hint}`);
  }
  console.error(
    `\n判据 SoT：docs/conventions/information-boundary.md（三层归属 + 5 问自检）。` +
      `\n确属良性 → 登记 ${ALLOWLIST_REL} 并写理由（**按值登记，永不按路径**）。` +
      `\n紧急出口：git commit --no-verify（但 CI 那一层绕不过）。`,
  );
  process.exit(1);
}

function main(): void {
  const argv = process.argv.slice(2);
  const allow = loadAllowlist();

  const msgIdx = argv.indexOf('--commit-msg');
  if (msgIdx !== -1) {
    const f = argv[msgIdx + 1];
    if (!f || !existsSync(f)) {
      console.error('❌ --commit-msg 需要一个存在的文件路径');
      process.exit(2);
    }
    // commit message 里的标识符是历史上真实发生过的泄漏形态，且文件扫描对它完全无效。
    // L2 在这里同样要跑 —— 首版把它硬写成 'off'，于是 message 面只有 L1，而提示语还
    // 声称「本机无 fleet.env」（文件存在时那是**假话**）。一个说假话的降级提示比没有
    // 提示更坏：它让人以为已经查过了。
    const text = readFileSync(f, 'utf8');
    const msgFindings = scanText('<commit-msg>', text, allow);
    let msgL2: 'on' | 'off' = 'off';
    const msgFleet = join(homedir(), '.nvy', 'fleet.env');
    if (existsSync(msgFleet)) {
      msgL2 = 'on';
      msgFindings.push(
        ...scanForValues(
          { '<commit-msg>': text },
          deriveValueLiterals(readFileSync(msgFleet, 'utf8')),
        ),
      );
    }
    report(msgFindings, '扫 1 条 commit message', msgL2);
    return;
  }

  const staged = argv.includes('--staged');
  const paths = staged
    ? execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], {
        cwd: REPO_ROOT,
        maxBuffer: 64 * 1024 * 1024,
      })
        .toString('utf8')
        .split('\0')
        .filter(Boolean)
    : trackedPaths();

  const files = readAll(paths);
  const findings = scanFiles(files, allow);

  // L2 只在 dev 机生效：fleet.env 不存在（CI / 新 clone）时显式跳过并说明，
  // 让「降级」响而不是静默 —— 但 L1 已经无条件跑过了，所以不存在零保护窗口。
  const fleetPath = join(homedir(), '.nvy', 'fleet.env');
  let l2: 'on' | 'off' = 'off';
  if (existsSync(fleetPath)) {
    l2 = 'on';
    findings.push(...scanForValues(files, deriveValueLiterals(readFileSync(fleetPath, 'utf8'))));
  }

  report(findings, `扫 ${Object.keys(files).length} 个${staged ? '暂存' : ' tracked '}文件`, l2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
