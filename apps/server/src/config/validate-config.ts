/**
 * validate-config.ts — pre-deploy config gate (B2; consumed by deploy.yml).
 *
 * Runs the SAME Zod config factories the server parses at boot, against the
 * current process env, WITHOUT booting Nest / connecting Prisma|Redis. deploy.yml
 * invokes it as a pre-flight `docker compose run --rm --no-deps` step (so the env
 * is resolved exactly as the real container's `environment:` block — composed
 * DATABASE_URL/REDIS_URL + `:-` defaults included) BEFORE recreating the live
 * app. This moves fail-fast from boot time (too late — already recreated into a
 * crash → downtime) to deploy time (abort before touching the running container).
 *
 * Exit codes:
 *   0 — every config group parsed OK.
 *   2 — one or more config errors (distinct code so the deploy script can branch
 *       on "bad config, do NOT recreate").
 *
 * Aggregates ALL failures (not first-fail) so one run lists every missing/invalid
 * key — per env-validation best practice (collect-all, don't surface one per
 * redeploy). Mirrors scripts/checks/check-env-sync.ts which guards the in-repo
 * side (.env.example / compose mapping); this guards the live prod values.
 */
import {
  appConfig,
  authConfig,
  dbConfig,
  redisConfig,
  smsConfig,
  jpushConfig,
  deepseekConfig,
  minimaxConfig,
  iqsConfig,
  codeIndexConfig,
  ossConfig,
  wechatConfig,
  marketdataConfig,
  marketdataSyncConfig,
  asrConfig,
  agentBridgeConfig,
} from './index.js';

// @nestjs/config registerAs returns a callable factory; invoking it runs the
// embedded Zod `.parse()` exactly as ConfigModule does during boot. Discriminated
// unions (sms/jpush/wechat/marketdata/codeIndex/asr) only require credentials for
// the active `kind`, so a default 'mock'/'fake' env validates without false positives.
//
// 🚨 THIS LIST MUST MIRROR `security.module.ts` `ConfigModule.forRoot({ load: [...] })`
// — order included, so the two are diffable side by side. A factory that boots but
// is absent here means the gate says OK and the container still crashes on recreate,
// i.e. exactly the downtime this gate exists to prevent. (2026-08-02: codeIndex /
// asr / agentBridge had drifted out of this list while loaded at boot.)
const FACTORIES: ReadonlyArray<readonly [string, () => unknown]> = [
  ['app', appConfig],
  ['auth', authConfig],
  ['db', dbConfig],
  ['redis', redisConfig],
  ['sms', smsConfig],
  ['jpush', jpushConfig],
  ['deepseek', deepseekConfig],
  ['minimax', minimaxConfig],
  ['iqs', iqsConfig],
  ['codeIndex', codeIndexConfig],
  ['oss', ossConfig],
  ['wechat', wechatConfig],
  ['marketdata', marketdataConfig],
  ['marketdataSync', marketdataSyncConfig],
  ['asr', asrConfig],
  ['agentBridge', agentBridgeConfig],
];

function main(): void {
  const failures: string[] = [];
  for (const [name, factory] of FACTORIES) {
    try {
      factory();
    } catch (err) {
      // ZodError carries structured `.issues`; render one readable line per
      // offending field (path: message) instead of dumping raw JSON.
      const issues = (err as { issues?: Array<{ path?: unknown[]; message: string }> })?.issues;
      if (Array.isArray(issues)) {
        for (const issue of issues) {
          const path = (issue.path ?? []).join('.') || '(root)';
          failures.push(`  ✗ [${name}] ${path}: ${issue.message}`);
        }
      } else {
        failures.push(`  ✗ [${name}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  if (failures.length > 0) {
    console.error('❌ config validation failed (pre-deploy gate):\n');
    console.error(failures.join('\n\n'));
    console.error(
      '\nFix the above in .env.production (real values; empty string counts as missing for',
    );
    console.error('required keys), then re-run the deploy. The live container was NOT recreated.');
    process.exit(2);
  }

  console.log(`✅ config validation: all ${FACTORIES.length} config groups parsed OK.`);
}

main();
