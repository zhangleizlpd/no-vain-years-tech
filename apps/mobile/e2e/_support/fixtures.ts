import { test as base } from '@playwright/test';

/**
 * Hermetic e2e 的兜底闸：任何**没被 spec 显式 mock** 的 `/api/**` 请求一律 abort。
 *
 * 为什么需要：spec 只 mock 自己直接用到的 URL，但 authed 屏还挂着别的 query
 * （如「我的」屏的 `/alert/messages`）。这些请求走 bundle 默认 base URL 打向
 * `localhost:3000` —— 于是这套「hermetic」套件的隔离性，实际上依赖**那个端口恰好没人监听**，
 * 而不是任何显式声明。本机开着 dev server 时它就漏了：
 *   真 server 认真校验 seed 的假 token → 401 → refresh 拦截器 → 假 refreshToken 同样 401
 *   → clearSessionAndCache() 清 session → AuthGate 跳登录页 → 后续断言全挂。
 * 2026-09-01 实证：开着 server 跑 runtime-smoke 22 failed，停掉 server 同一份代码 265 全绿。
 * CI 从不受影响（那里 :3000 空着），所以这是一类**只在本机复现、且方向反直觉**的假红。
 *
 * 🚨 **注册时机决定成败**：playwright 的多个 route handler 按**注册的逆序**执行
 * （最后注册的先跑）。本 handler 在 page fixture 里注册，早于任何 test body 里的
 * `mockJson`，因此它最后才跑 —— 显式 mock 永远优先，只有谁都没认领的请求才落到这里。
 * 同理 `mockJson` 里 method 不匹配时的 `route.fallback()` 也会一路传到这儿，
 * 链条末端从「走真网络」变成 abort。**不要把它挪到 test body 里**，那会反过来盖住显式 mock。
 *
 * abort 而非 fulfill(4xx)：要复刻的是「端口空着」那个语义 —— 网络层失败。返回 4xx 会被
 * 401 拦截器当成真业务响应处理（refresh → 清 session），恰好就是我们要消掉的那条路径。
 *
 * 不适用者：`real-backend.spec.ts` 是仓里唯一 non-hermetic 的 spec（打真 server + SMOKE_* env，
 * 只经 `playwright.real-backend.config.ts` 跑），它**刻意**不引本模块，仍直接从
 * `@playwright/test` 导入。
 */
export const test = base.extend({
  page: async ({ page }, use) => {
    await page.route('**/api/**', (route) => route.abort());
    await use(page);
  },
});

export { expect } from '@playwright/test';
export type { Locator, Page, Route } from '@playwright/test';
