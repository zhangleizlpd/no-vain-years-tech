import { defineConfig, devices } from '@playwright/test';

// markets-OFF 合规回归 config（fast-follow of #445，方向 B 门控机制
// docs/private/plans/2026-06/06-14-markets-feature-gate-mechanism.md §Fast-follow）。
//
// 与 playwright.config.ts（markets-ON 主套件）的关键差异 —— 三处隔离，缺一会假绿/串台：
//
//   1. **bundle 必须 markets-OFF**：`EXPO_PUBLIC_FEATURE_MARKETS` 是 build-time 内联常量
//      （feature-flags.ts），由 webServer 子进程在打包时定值。主 e2e target 把它设 'true'；
//      本 config 在 webServer.env 里显式钉 'false'，**不依赖**外层不设环境变量——防 shell
//      泄漏的 'true' 串进来把投资/行情打开（fail-safe：合规测必须确定性 OFF）。
//   2. **独立端口 + 永不复用**：默认 4174（≠ 主套件 4173），且 reuseExistingServer:false。
//      若复用了一个 markets-ON 的 :4173 dev server，会拿到错 bundle → 投资 Tab 反而出现 →
//      合规断言假绿。独立端口 + 强制 fresh boot 杜绝串台。
//   3. **testMatch 只跑本 spec**：markets-OFF 下既有 portfolio/alert/stock-market e2e 全会红
//      （它们假定行情开着）。testMatch 把本 config 锁死到唯一的合规 spec；反向地，主套件 +
//      runtime-smoke config 的 testIgnore 排除了 markets-feature-gate.spec.ts。两侧对称隔离。
const PORT = Number(process.env['EXPO_WEB_PORT'] ?? 4174);

export default defineConfig({
  testDir: './e2e',
  // 只跑合规门控 spec（见上 §3）。其余 spec 假定 markets-ON，在此 config 下必红。
  testMatch: 'markets-feature-gate.spec.ts',
  outputDir: './playwright-test-results',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 1 : 0,
  reporter: [['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], hasTouch: true },
    },
  ],
  webServer: {
    command: `pnpm exec expo start --web --port ${PORT}`,
    url: `http://localhost:${PORT}`,
    // 永不复用（见上 §2）—— 合规测必须每次拿到一个确定 markets-OFF 的 fresh bundle。
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
    // markets-OFF 的唯一真相源（见上 §1）：Metro 打包时把 process.env.EXPO_PUBLIC_FEATURE_MARKETS
    // 内联进 bundle，这里钉 'false' → FEATURE_MARKETS_ENABLED 恒 false → 公开版语义。
    env: { EXPO_PUBLIC_FEATURE_MARKETS: 'false' },
  },
});
