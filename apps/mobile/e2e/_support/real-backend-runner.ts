/**
 * 真后端 smoke — orchestrator (per docs/private/plans/2026-05/
 * 05-29-e2e-backend-boundary-hardening.md P2, layer「真后端 smoke」).
 *
 * The bulk FE e2e suite stubs the network boundary (hermetic, fast). This ONE
 * journey deliberately does the opposite: it stands up a REAL, throwaway backend
 * and proves the client's cold-boot session-bootstrap chain works against it —
 * refresh-token rotation + GET /me + AuthGate routing. Catches drift that a
 * stubbed suite can't (e.g. a server DTO / auth change that the mocks don't
 * mirror), complementing the type-level contract guard (src/core/api/
 * backend-contract.spec.ts).
 *
 * boot + 程序化登录 已抽到共享 `real-backend-harness.ts`（bootRealBackend）—— 本 runner
 * 只负责：env-gate → boot harness → 把真 refreshToken 经 env 交给 Playwright child →
 * 跑浏览器冷启动鉴权链冒烟 → teardown。node 层的契约冒烟（生成客户端打真 server）走
 * 同一 harness 的另一消费方 contract-smoke/run.ts。
 *
 * Env-gated 独立 job: no-ops unless RUN_REAL_BACKEND_SMOKE=true so an accidental
 * local `nx run mobile:e2e-real-backend` without Docker exits 0 instead of
 * hanging (mirrors the RUN_PERF_IT pattern). CI runs it nightly, soft-signal.
 */
import { spawnSync } from 'node:child_process';

import { bootRealBackend } from './real-backend-harness';

const GATE = 'RUN_REAL_BACKEND_SMOKE';
if (process.env[GATE] !== 'true') {
  console.log(`[real-backend-smoke] ${GATE} !== 'true' — skipping (env-gated 独立 job).`);
  process.exit(0);
}

async function main(): Promise<number> {
  const ctx = await bootRealBackend();
  try {
    console.log('[real-backend-smoke] running Playwright cold-boot smoke…');
    const pw = spawnSync(
      'pnpm',
      ['exec', 'playwright', 'test', '-c', 'playwright.real-backend.config.ts'],
      {
        cwd: process.cwd(),
        stdio: 'inherit',
        env: {
          ...process.env,
          SMOKE_ACCOUNT_ID: ctx.accountId,
          SMOKE_REFRESH_TOKEN: ctx.refreshToken,
          SMOKE_DISPLAY_NAME: ctx.displayName,
        },
      },
    );
    return pw.status ?? 1;
  } finally {
    await ctx.teardown();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[real-backend-smoke] FAILED:', err);
    process.exit(1);
  });
