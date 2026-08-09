#!/usr/bin/env node
/**
 * check-env-sync.ts — validate .env ↔ .env.example key alignment + process.env refs.
 *
 * Algorithm (per ADR-0037 § 2):
 *   A. K_example = keys in .env.example; K_env = keys in .env (skip if absent —
 *      .env is gitignored). K_example != K_env → fail (values not checked).
 *   B. K_referenced = grep process.env.X across apps/**\/*.ts(x);
 *      K_referenced ⊄ K_example ∪ ALLOWLIST → fail.
 *   B'. …and the reverse: K_example ⊄ K_referenced → fail. B alone is one-directional
 *      (code → template), so a key whose only consumer got deleted just sits there
 *      forever; and because A forces .env to mirror .env.example key-for-key, every
 *      dev then has to carry that dead key. 2026-08-02: RESEND_API_KEY /
 *      RESEND_BASE_URL / MAIL_FROM had been doing exactly that (zero consumers
 *      repo-wide). Fix is either "comment it out" or "widen SRC_DIRS" — see the
 *      error message.
 * Prod-reach (boot-required secrets must not crash prod):
 *   C. each key placeholdered in apps/server/vitest.config.ts test.env (the forced
 *      registry of boot-blocking secrets) must be declared in .env.production
 *      (non-secret config) OR secrets.enc.env (SOPS-managed secret).
 *   D. ...and mapped in docker-compose.tight.yml app environment block (the container
 *      only sees explicitly-mapped vars). Missing map = value in .env.production but
 *      unread = prod boot crash (the 2026-06-04 MARKETDATA_TICK + 029 chat-key trap).
 * Secret routing (secrets are encrypted, never plaintext):
 *   E. every boot-required SECRET (name matches SECRET_KEY_RE) must live in
 *      secrets.enc.env (SOPS), + a sentinel that every value there is ciphertext.
 *   F. a secret-named key must NOT carry a plaintext value in .env.production (now
 *      tracked, repo public) — secrets belong encrypted in the OUT-OF-REPO secrets.enc.env (covers
 *      non-boot-required secrets that E misses, e.g. a fake-default optional key).
 *      Dev .env.example is exempt (carries non-empty dev placeholders for local boot).
 * Dev↔prod non-secret parity:
 *   G. every NON-SECRET key in .env.production must also be documented in dev
 *      apps/server/.env.example (prod ⊆ dev), except ENV_SPECIFIC_ALLOWLIST. Dev is
 *      the superset onboarding template; prod only sets keys overriding a default,
 *      so the reverse direction is unconstrained.
 * Dead-config reach (2026-08-03, P3 步 4 的「Check D 收紧」— D 的反方向):
 *   H. every key DECLARED in .env.production or secrets.enc.env must be referenced
 *      somewhere in docker-compose.tight.yml (env mapping line OR ${KEY} interpolation
 *      both count). Declared-but-unreachable = the operator thinks it's configured but
 *      the container never sees it → the silent-fallback incident class in its GENERAL
 *      form (2026-06-04 marketdata tick / 029 chat keys / #799 SMS template codes were
 *      instances; each fix only plugged known keys). D anchors the boot-required subset
 *      (test.env registry); H anchors the "declared ⇒ reachable" full set. Keys consumed
 *      ONLY by host-side deploy tooling go in HOST_ONLY_PROD_KEYS with the consumer noted.
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-env-sync.ts       # scan all configured pairs
 *   lefthook pre-commit hook triggers on staged .env* changes
 */

import { readFileSync, existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Script lives at scripts/checks/ → repo root is two levels up.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const ENV_PAIRS: Array<{ example: string; env: string }> = [
  { example: 'apps/server/.env.example', env: 'apps/server/.env' },
];

// Standard runtime / framework / CI env vars not required in .env.example.
// Test-only opt-in flags (RUN_PERF_IT / PERF_IT_REPS) belong here — they
// are vitest gate flags, not application config.
const ALLOWLIST = new Set([
  'PORT',
  'NODE_ENV',
  'CI',
  'GITHUB_ACTIONS',
  'RUN_PERF_IT',
  'PERF_IT_REPS',
  // 047 T038 预热轮数 (optionsdesk-047.legs-perf.it.spec.ts)：前 N 次请求不计入分布,
  // 扛 V8 JIT 未热 / Prisma 首建连接。与 PERF_IT_REPS 同族的 vitest gate 旋钮,非 application config。
  'PERF_IT_WARMUP',
  // SC-005 单 tick 重放数 (alert-realtime-eval.it.spec.ts)。独立于 PERF_IT_REPS —— 那是
  // auth P95 采样数 (nightly 300)，一个完整 tick rep 贵三个量级，误共享 = nightly 必超时。
  'PERF_TICK_REPS',
  // vitest 运行时自动注入 (sms-code.rules.ts 用 !process.env.VITEST 区分测试 vs dev)。
  'VITEST',
  // 真发 SMS env-gated IT (apps/server/test/integration/aliyun-sms.real-send.vendor.spec.ts)
  // opt-in flag + 测试手机号 — vitest gate / 测试输入,非 application config。
  // (ALIYUN_ACCESS_KEY_ID/SECRET/SIGN_NAME/TEMPLATE_CODE 已在 .env.example。)
  'RUN_SMS_IT',
  'SMS_IT_PHONE',
  // Expo build-time public var (apps/mobile/src/core/api/setup.ts). EXPO_PUBLIC_*
  // is an Expo framework prefix baked into the web bundle at export; mobile has
  // no server-style .env/.env.example pair, so it is declared here.
  'EXPO_PUBLIC_API_BASE_URL',
  // markets feature flag — Expo public, baked at export (apps/mobile/src/core/feature-flags.ts).
  'EXPO_PUBLIC_FEATURE_MARKETS',
  // OSS public asset base URL — Expo public, baked at export (apps/mobile/src/ideation/
  // use-ideation-session.ts; 036 T021). Optional, defaults to '' (real OSS wiring sets it
  // via deploy-web.yml); EXPO_PUBLIC_* is mobile build-time, not a server boot key.
  'EXPO_PUBLIC_OSS_PUBLIC_BASE_URL',
  // env-gated IT opt-in flags (vitest gates, not application config) — mirror RUN_PERF_IT.
  'RUN_LLM_IT',
  'RUN_MARKETDATA_IT',
  // env-gated IT opt-in flag for real code-index connectivity (ideation-grounding.it.spec.ts; 034 T007).
  'RUN_CODEINDEX_IT',
  // env-gated IT opt-in flag + 样本路径 for real DashScope 一次性 ASR (ideation-asr-transcribe.it.spec.ts;
  // 035 一次性识别 Replan)。RUN_ASR_IT (旧 WS IT) 已随 WS 栈下线退役。
  'RUN_ASR_SYNC_IT',
  'ASR_SYNC_IT_SAMPLE',
  // contract-smoke / dev toggle binding the deterministic FakeLlmProvider (chat.module.ts).
  'CHAT_FAKE_LLM',
  // contract-smoke / dev toggle binding the deterministic FakeSearchProvider (chat.module.ts; 030).
  'CHAT_FAKE_SEARCH',
  // P2 PoC-1 共享 PG 原型的进程内传递（globalSetup 主进程 → worker）。非应用配置。
  'POC_PG_ADMIN_URI',
  // contract-smoke / dev toggle binding the deterministic FakeIdeationLlmProvider (ideation.module.ts; 032).
  'IDEATION_FAKE_LLM',
  // env-gated IT opt-in flag for real IQS connectivity smoke (iqs-search.vendor.spec.ts; 030 T003).
  'RUN_IQS_IT',
  // env-gated IT opt-in flags + test input for real OSS round-trip & real M3 vision
  // (ideation-image-attachment.it.spec.ts / minimax-vision.real-send.vendor.spec.ts; 036 T001/T007).
  // RUN_*_IT = vitest gates; M3_VISION_IT_IMAGE_URL = optional test image URL (default 内置 data: PNG).
  'RUN_OSS_IT',
  'RUN_M3_VISION_IT',
  'M3_VISION_IT_IMAGE_URL',
  // Optional server config WITH a schema .default() in apps/server/src/config/*.config.ts —
  // the default (and its rationale) is the single source of truth in the .config.ts itself,
  // so these are NOT duplicated in .env.example. Set via env only to override. Adding a NEW
  // such optional key → list it here; a NEW *required* key (no default) → .env.example instead.
  'DEEPSEEK_BASE_URL',
  'DEEPSEEK_MODEL',
  'MINIMAX_BASE_URL',
  'IQS_BASE_URL',
  'LIXINGER_BASE_URL',
  'EASTMONEY_BASE_URL',
  'EASTMONEY_CLIST_BASE_URL',
  'TENCENT_CALENDAR_BASE_URL',
  'MARKETDATA_TICK_ENABLED',
  'MARKETDATA_BACKFILL_HISTORY_DAYS',
  'MARKETDATA_SYNC_REQUEUE_DELAY_MS',
  'MARKETDATA_CLI_WAIT_TIMEOUT_MS',
  'MARKETDATA_SYNC_REMOVE_ON_COMPLETE_COUNT',
  'MARKETDATA_SYNC_REMOVE_ON_FAIL_COUNT',
  // 047 FR-045 期权快照逐票覆盖率告警阈值; 默认 1 (100%), 校准期由 env 放宽。
  'MARKETDATA_OPTION_COVERAGE_THRESHOLD',
]);

// Check G allowlist: NON-SECRET keys legitimately present in prod .env.production
// but NOT in dev apps/server/.env.example — genuinely env-specific config the dev
// onboarding template has no reason to carry. Keep this SMALL and explicit; a new
// non-secret key should normally land in BOTH files (that's what /config-add does).
//   - MBW_VERSION: prod image tag (deploy.yml exports it); dev runs `nx serve`, no image.
//   - DB_USERNAME: prod compose assembles DATABASE_URL from it; dev sets DATABASE_URL whole.
//   - MARKETDATA_TICK_ENABLED: 017 gray-release flag, prod flips it; dev relies on default.
const ENV_SPECIFIC_ALLOWLIST = new Set(['MBW_VERSION', 'DB_USERNAME', 'MARKETDATA_TICK_ENABLED']);

// Check H allowlist: keys deliberately consumed ONLY by host-side deploy tooling,
// never inside the app container — the only legitimate reason for a declared prod key
// to have ZERO references in docker-compose.tight.yml. Empty as of 2026-08-03 (every
// declared key is compose-reachable; MBW_VERSION/DB_USERNAME reach it via ${KEY}
// interpolation, which counts). Add entries WITH the host-side consumer noted.
const HOST_ONLY_PROD_KEYS = new Set<string>([]);

// Files that carry the prod boot-required-secret contract (Checks C/D/E).
// .env.production is now TRACKED (non-secret prod config; was an `.example`
// template + manual server-side fill pre-SOPS-cutover).
const PROD_ENV = '.env.production';
const COMPOSE_TIGHT = 'docker-compose.tight.yml';
const VITEST_CONFIG = 'apps/server/vitest.config.ts';
// SOPS-encrypted prod secret registry (per spike 06-15-sops-age-secrets-adoption).
// Key names are PLAINTEXT in a SOPS dotenv, so CI greps them WITHOUT the age
// private key. Check E enforces every boot-required secret lives here.
// 密文文件名。仓已公开 → 密文本体移出仓（gitignored），三处解析顺序：
//   1. NVY_SECRETS_ENC（部署链显式指定，如 prod 的 /etc/nvy/secrets.enc.env）
//   2. 仓内同名文件（切换期与本地开发的兼容路径）
//   3. ~/.nvy/secrets.enc.env（dev 机常态）
// 🚨 为什么 key 名留在仓内、只移密文：key 名是**契约**（Check C/E/H 都靠它对账），
//    且它本来就是明文。移走密文消除的是「密文一旦公开就永久公开、将来私钥一泄漏
//    即全量回溯解密」这条不可撤销的风险，与 key 名可见性无关。
const SECRETS_ENC = process.env.NVY_SECRETS_ENC ?? 'secrets.enc.env';
// Value-sensitive key suffixes — mirror .sops.yaml encrypted_regex. A boot-required
// key matching this belongs in secrets.enc.env (SOPS), not loose in .env.production.
// CODE_INDEX_URL and FUTU_SHIM_URL are special-cased (literals, not suffixes): a
// WireGuard tunnel endpoint is treated as a SOPS-managed secret alongside its own
// token (CODE_INDEX_SERVICE_TOKEN / FUTU_SHIM_TOKEN) — one wiring unit, one route.
const SECRET_KEY_RE = /_KEY|_SECRET|_TOKEN|_PASSWORD|HMAC|CODE_INDEX_URL|FUTU_SHIM_URL/;

const SRC_DIRS = ['apps/server/src', 'apps/server/test', 'apps/mobile/src'];

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.expo', 'generated']);

function parseEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^([A-Z_][A-Z0-9_]*)=/.exec(line);
    if (m) keys.add(m[1]);
  }
  return keys;
}

// Boot-required secrets are operationally defined as the placeholder keys in
// apps/server/vitest.config.ts `test.env`: a key lands there precisely because
// every boot-AppModule IT calls config `.parse()` which rejects it empty (server
// IT goes red otherwise — pr-validation enforces). That makes test.env the forced
// registry of "secrets the server cannot boot without". Each such key MUST also
// reach prod — declared in .env.production (non-secret) or secrets.enc.env (secret)
// AND mapped in docker-compose.tight.yml (the container only sees mapped vars).
// Checks C/D below enforce exactly that, closing the gap that bit MARKETDATA_TICK
// (2026-06-04) and the chat LLM keys (029): value in .env.production but no compose
// mapping → container reads nothing → prod boot crash.
function parseVitestBootRequiredKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const block = /\benv:\s*{([\s\S]*?)}/.exec(content);
  if (!block) return keys;
  const re = /([A-Z_][A-Z0-9_]*)\s*:/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block[1])) !== null) keys.add(m[1]);
  return keys;
}

// Every `  KEY:` mapping line in any compose environment block. Boot-required app
// secrets only appear under the app service, so a global scan is safe (a postgres
// var never collides with the checked set).
function parseComposeEnvKeys(content: string): Set<string> {
  const keys = new Set<string>();
  const re = /^\s+([A-Z_][A-Z0-9_]*):/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) keys.add(m[1]);
  return keys;
}

// Token presence (incl. commented lines) — prod example may document a key
// commented when conditionally required; that still counts as "declared".
function fileHasToken(content: string, key: string): boolean {
  return new RegExp(`\\b${key}\\b`).test(content);
}

async function walkTs(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...(await walkTs(join(dir, e.name))));
    } else if (e.name.endsWith('.ts') || e.name.endsWith('.tsx')) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

async function findEnvRefs(): Promise<Set<string>> {
  const refs = new Set<string>();
  const re = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
  for (const dir of SRC_DIRS) {
    const files = await walkTs(join(REPO_ROOT, dir));
    for (const f of files) {
      // Drop whole-line comments so doc mentions of `process.env.X` in comments
      // aren't mistaken for real refs (e.g. mobile setup.ts `EXPO_PUBLIC_*` note).
      const content = readFileSync(f, 'utf8')
        .split('\n')
        .filter((line) => {
          const t = line.trim();
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
        })
        .join('\n');
      let m: RegExpExecArray | null;
      while ((m = re.exec(content)) !== null) {
        refs.add(m[1]);
      }
    }
  }
  return refs;
}

function setDiff<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

async function main(): Promise<void> {
  const errors: string[] = [];
  const allExampleKeys = new Set<string>();

  for (const { example, env } of ENV_PAIRS) {
    const examplePath = join(REPO_ROOT, example);
    const envPath = join(REPO_ROOT, env);

    if (!existsSync(examplePath)) {
      errors.push(`Missing ${example}`);
      continue;
    }
    const K_example = parseEnvKeys(readFileSync(examplePath, 'utf8'));
    K_example.forEach((k) => allExampleKeys.add(k));

    if (!existsSync(envPath)) {
      console.log(
        `ℹ️  ${env} absent (gitignored / not yet provisioned) — skipping pair-diff check`,
      );
      continue;
    }
    const K_env = parseEnvKeys(readFileSync(envPath, 'utf8'));
    const onlyExample = setDiff(K_example, K_env);
    const onlyEnv = setDiff(K_env, K_example);
    if (onlyExample.length) {
      errors.push(`${example} has keys NOT in ${env}: ${onlyExample.join(', ')}`);
    }
    if (onlyEnv.length) {
      errors.push(`${env} has keys NOT in ${example}: ${onlyEnv.join(', ')}`);
    }
  }

  const refs = await findEnvRefs();
  const undeclared = [...refs].filter((k) => !allExampleKeys.has(k) && !ALLOWLIST.has(k));
  if (undeclared.length) {
    errors.push(
      `process.env.<KEY> refs not declared in any .env.example or ALLOWLIST: ${undeclared.join(', ')}`,
    );
  }

  // Check B' — the reverse direction. Without it a template key outlives its last
  // consumer silently, and Check A then forces that dead key into everyone's .env.
  const unconsumed = [...allExampleKeys].filter((k) => !refs.has(k));
  if (unconsumed.length) {
    errors.push(
      `.env.example declares key(s) with NO process.env.<KEY> consumer under ${SRC_DIRS.join(
        ' / ',
      )}: ${unconsumed.join(', ')} — if genuinely unused, comment the line out (\`# KEY=\`, keeps the note, drops the dead key); if consumed outside those dirs (scripts/ services/ …), widen SRC_DIRS instead.`,
    );
  }

  // Check G: dev↔prod NON-SECRET parity. Every non-secret key set in prod
  // .env.production must also be documented in dev apps/server/.env.example
  // (prod ⊆ dev), except ENV_SPECIFIC_ALLOWLIST. Dev .env.example is the superset
  // onboarding template listing every key; prod .env.production only sets keys that
  // override a schema/compose default — so dev-only keys are normal and the reverse
  // direction is NOT enforced. Secrets are excluded (they live in secrets.enc.env,
  // neither plaintext file; Checks C/E cover them). Catches the drift where a new
  // prod non-secret key was added without documenting it in the dev template.
  const prodEnvPathForG = join(REPO_ROOT, PROD_ENV);
  if (existsSync(prodEnvPathForG)) {
    const prodKeys = parseEnvKeys(readFileSync(prodEnvPathForG, 'utf8'));
    const undocumentedProd = [...prodKeys].filter(
      (k) => !SECRET_KEY_RE.test(k) && !allExampleKeys.has(k) && !ENV_SPECIFIC_ALLOWLIST.has(k),
    );
    if (undocumentedProd.length) {
      errors.push(
        `${PROD_ENV} has non-secret key(s) not documented in dev apps/server/.env.example: ${undocumentedProd.join(', ')} — add them to the dev template too (or to ENV_SPECIFIC_ALLOWLIST in scripts/checks/check-env-sync.ts if genuinely prod-only).`,
      );
    }
  }

  // Checks C & D: every boot-required secret must reach prod (declared + mapped).
  const vitestPath = join(REPO_ROOT, VITEST_CONFIG);
  if (!existsSync(vitestPath)) {
    console.log(`ℹ️  ${VITEST_CONFIG} absent — skipping boot-required prod-reach checks (C/D)`);
  } else {
    const bootRequired = parseVitestBootRequiredKeys(readFileSync(vitestPath, 'utf8'));

    // SOPS secret registry (Check E source): key names plaintext → grep, never decrypt.
    // 绝对路径（NVY_SECRETS_ENC 指定）直接用；否则仓内优先、回落 dev 机 ~/.nvy/。
    const secretsEncPath = SECRETS_ENC.startsWith('/')
      ? SECRETS_ENC
      : existsSync(join(REPO_ROOT, SECRETS_ENC))
        ? join(REPO_ROOT, SECRETS_ENC)
        : resolve(homedir(), '.nvy', 'secrets.enc.env');
    const secretsEncExists = existsSync(secretsEncPath);
    const secretsEncContent = secretsEncExists ? readFileSync(secretsEncPath, 'utf8') : '';
    const secretsEncKeys = secretsEncExists ? parseEnvKeys(secretsEncContent) : new Set<string>();

    // C: declared so the operator knows to provide it — in .env.production
    // (non-secret config) OR secrets.enc.env (SOPS-managed secret; post-cutover the
    // secret rows leave the plaintext .env.production, so the union keeps C from breaking).
    const prodEnvPath = join(REPO_ROOT, PROD_ENV);
    let prodDeclaredKeys = new Set<string>();
    if (!existsSync(prodEnvPath)) {
      errors.push(`Missing ${PROD_ENV}`);
    } else {
      const prodContent = readFileSync(prodEnvPath, 'utf8');
      prodDeclaredKeys = parseEnvKeys(prodContent);
      // 🚨 Check C 的 secret 那半在「密文注册表读不到」时**显式降级**为只查非密 key。
      // 不降级的后果：CI 上（无仓内密文、无 ~/.nvy）boot-required secret 恒报缺失 —— 一个
      // 恒红的闸等于没有闸，它会被人加 `|| true` 绕掉。降级必须**响出来**而不是静默，
      // 否则「绿」就不再区分「真对账过」与「压根没查」。Check E 早就是这个形状。
      if (!secretsEncExists) {
        console.log(
          `ℹ️  secret registry unreadable (${SECRETS_ENC}) — Check C degraded to non-secret keys only; ` +
            `Check E / ciphertext sentinel skipped. 本地想全量对账：export NVY_SECRETS_ENC=/abs/path 或放 ~/.nvy/secrets.enc.env`,
        );
      }
      const missingProd = [...bootRequired].filter(
        (k) =>
          !fileHasToken(prodContent, k) &&
          !secretsEncKeys.has(k) &&
          !(!secretsEncExists && SECRET_KEY_RE.test(k)),
      );
      if (missingProd.length) {
        errors.push(
          `boot-required keys (from ${VITEST_CONFIG} test.env) absent in both ${PROD_ENV} and ${SECRETS_ENC}: ${missingProd.join(', ')}`,
        );
      }

      // Secret-routing sentinel (Check F): a secret-named key (SECRET_KEY_RE) carrying a
      // real VALUE in the plaintext, now-tracked .env.production means a secret was put
      // where it doesn't belong — secrets live encrypted in secrets.enc.env (`sops edit`),
      // per ops/runbook/secrets-sops.md. This catches the routing mistake for ANY secret,
      // not just boot-required ones (Check E only covers the boot-required subset, so a
      // fake-default optional secret like DASHSCOPE_API_KEY would otherwise slip through
      // into plaintext uncaught). Allowed: empty declaration (`KEY=`) and commented
      // placeholder (`# KEY=`). The dev .env.example is EXEMPT on purpose — it carries
      // non-empty dev placeholders (AUTH_JWT_SECRET / DEEPSEEK_API_KEY …) for local boot.
      const prodPlaintextSecrets: string[] = [];
      for (const rawLine of prodContent.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (!m) continue;
        const val = m[2]
          .trim()
          .replace(/^["']|["']$/g, '')
          .trim();
        if (SECRET_KEY_RE.test(m[1]) && val !== '') prodPlaintextSecrets.push(m[1]);
      }
      if (prodPlaintextSecrets.length) {
        errors.push(
          `${PROD_ENV} has secret-named key(s) with a plaintext value — secrets belong encrypted in ${SECRETS_ENC} (\`sops ${SECRETS_ENC}\`), not the tracked plaintext ${PROD_ENV}: ${prodPlaintextSecrets.join(', ')}`,
        );
      }
    }

    // D: mapped in docker-compose.tight.yml (container only sees mapped vars).
    const composePath = join(REPO_ROOT, COMPOSE_TIGHT);
    if (!existsSync(composePath)) {
      errors.push(`Missing ${COMPOSE_TIGHT}`);
    } else {
      const composeContent = readFileSync(composePath, 'utf8');
      const composeKeys = parseComposeEnvKeys(composeContent);
      const unmapped = [...bootRequired].filter((k) => !composeKeys.has(k));
      if (unmapped.length) {
        errors.push(
          `boot-required keys (from ${VITEST_CONFIG} test.env) NOT mapped in ${COMPOSE_TIGHT} app environment block: ${unmapped.join(', ')}`,
        );
      }

      // H: declared ⇒ compose-reachable (Check D 的反方向, 见文件头)。声明在
      // .env.production / secrets.enc.env 的键若在 compose 里零引用 (映射行与
      // ${KEY} 插值都算引用), 就是「操作者以为配了、容器根本看不见」的死配置 ——
      // G-3 静默 fallback 事故类的通用形态。2026-08-03 实测现状零违规, 纯防未来。
      const unreachableProd = [...new Set([...prodDeclaredKeys, ...secretsEncKeys])].filter(
        (k) => !HOST_ONLY_PROD_KEYS.has(k) && !fileHasToken(composeContent, k),
      );
      if (unreachableProd.length) {
        errors.push(
          `declared-but-unreachable prod key(s): present in ${PROD_ENV} / ${SECRETS_ENC} but never referenced in ${COMPOSE_TIGHT} (neither env mapping nor \${KEY} interpolation) — the container will never see them (silent-fallback class): ${unreachableProd.join(', ')} — map them in the compose app environment block, or register in HOST_ONLY_PROD_KEYS with the host-side consumer noted.`,
        );
      }
    }

    // E (per spike §3.3): every boot-required SECRET (value-sensitive key) must live
    // in secrets.enc.env so SOPS propagates it to prod — turning "forgot to add the
    // prod secret" into a CI failure (no private key needed; key names are plaintext).
    if (secretsEncExists) {
      const bootSecrets = [...bootRequired].filter((k) => SECRET_KEY_RE.test(k));
      const missingEnc = bootSecrets.filter((k) => !secretsEncKeys.has(k));
      if (missingEnc.length) {
        errors.push(
          `boot-required secret(s) absent from ${SECRETS_ENC} (add via \`sops ${SECRETS_ENC}\`): ${missingEnc.join(', ')}`,
        );
      }
      // Sentinel (§5): every sensitive value must be ciphertext — catch an
      // accidentally-unencrypted commit before it lands (gitleaks is layer two).
      const plaintextSecrets: string[] = [];
      for (const rawLine of secretsEncContent.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m && SECRET_KEY_RE.test(m[1]) && !m[2].startsWith('ENC[')) {
          plaintextSecrets.push(m[1]);
        }
      }
      if (plaintextSecrets.length) {
        errors.push(
          `${SECRETS_ENC} has UNENCRYPTED secret value(s) — run \`sops -e -i ${SECRETS_ENC}\`: ${plaintextSecrets.join(', ')}`,
        );
      }
    }
  }

  if (errors.length) {
    console.error('❌ check-env-sync failed:\n');
    for (const e of errors) console.error(`  - ${e}`);
    console.error('\nFix:');
    console.error(
      '  - Keep .env and .env.example keys aligned (values may differ; .env is gitignored).',
    );
    console.error(
      '  - For new process.env.<KEY>: required key → add to apps/<app>/.env.example (+ local .env); optional key with a schema .default() / a test|framework flag → add to ALLOWLIST in scripts/checks/check-env-sync.ts.',
    );
    console.error(
      `  - For a new boot-required key (placeholdered in ${VITEST_CONFIG} test.env): non-secret → declare in ${PROD_ENV}; secret → \`sops edit ${SECRETS_ENC}\`. Either way map it in ${COMPOSE_TIGHT} app environment block (else prod boot crashes).`,
    );
    console.error(
      `  - For a new non-secret prod key: add it to BOTH ${PROD_ENV} and dev apps/server/.env.example (Check G), or to ENV_SPECIFIC_ALLOWLIST if genuinely prod-only.`,
    );
    console.error(
      `  - Secret routing: a key whose name matches ${SECRET_KEY_RE} is a SECRET → its value lives encrypted in ${SECRETS_ENC} (\`sops ${SECRETS_ENC}\`), NEVER as a plaintext value in ${PROD_ENV}. Non-secret config → plaintext ${PROD_ENV}. See ops/runbook/secrets-sops.md.`,
    );
    console.error(
      `  - Declared-but-unreachable (Check H): a key set in ${PROD_ENV} / ${SECRETS_ENC} must be referenced in ${COMPOSE_TIGHT} (env mapping or \${KEY} interpolation), else the container never sees it — map it, or if it is genuinely host-side-only, add it to HOST_ONLY_PROD_KEYS with the consumer noted.`,
    );
    process.exit(1);
  }

  console.log('✅ check-env-sync: K_example == K_env; process.env refs all declared.');
}

main().catch((err) => {
  console.error('check-env-sync internal error:', err);
  process.exit(2);
});
