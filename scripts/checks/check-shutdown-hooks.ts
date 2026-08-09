#!/usr/bin/env node
/**
 * check-shutdown-hooks.ts — 守住 prod 优雅关停的那一行接线。
 *
 * 不变量：`apps/server/src/main.ts` 必须调用 `app.enableShutdownHooks()`。
 *
 * 为什么值得一个专门的检查（#824）：
 * NestJS 官方明确，`onModuleDestroy` / `beforeApplicationShutdown` / `onApplicationShutdown`
 * **只在** 显式 `app.close()` 或（收到 SIGTERM/SIGINT **且** 调过 `enableShutdownHooks()`）时触发
 * （https://docs.nestjs.com/fundamentals/lifecycle-events）。少了这一行，本仓所有关停钩子
 * 在 prod **一个都不会跑** —— BullMQ Worker 不会 `close()`，in-flight job 直接变 stalled，
 * 而我们是**单实例部署**、没有第二个 worker 来接管。
 *
 * 关键在于**它的缺失是 100% 静默的**：服务照常起、照常跑、健康检查照常绿，只有在
 * 部署/重启的那一刻悄悄丢 job。事实上这一行缺了几个月都没人发现，直到 2026-08-02 排查
 * 另一个问题时才顺带撞见。⇒ 靠人眼守不住，必须机器守。
 *
 * ⚠️ 这里检查的是**源码文本**而不是运行时行为 —— 因为要验运行时就得起真进程 + 发 SIGTERM，
 * 那个成本进不了 PR 门。行为侧由 `test/integration/queue-shutdown-order.it.spec.ts` 覆盖
 * （证明 `close()` 真的会等 in-flight job），本检查只负责「那条通往 close() 的线还在」。
 *
 * Usage:
 *   pnpm tsx scripts/checks/check-shutdown-hooks.ts
 *   pr-validation.yml `gate-checks` job 每个 PR 无条件跑。
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MAIN_TS = 'apps/server/src/main.ts';

/**
 * 剥注释后再匹配 —— 注释里提到不算数。
 *
 * 🚨 **行尾注释也必须剥，本检查与 `check-test-size` 在这一点上蓄意不同。** 两者错误方向相反：
 * - 本检查断言**必需文本存在**（`enableShutdownHooks(`）⇒ 少剥 = 注释能冒充真调用 = **漏报**。
 *   实证形态：`const app = ...; // 别忘了 app.enableShutdownHooks()` 写在 `listen()` **之前**，
 *   真调用缺失也照样通过（写在 listen 之后才会被顺序检查偶然兜住）。多剥只会让它更严，
 *   最坏是误报（红得响，人会去看），不会静默放行。
 * - `check-test-size` 断言**违规文本不存在** ⇒ 多剥 = 漏掉真违规 = 静默失守，故它蓄意只剥整行。
 *
 * `(?<!:)` 是为了别把 `http://…` 拦腰截断（`main.ts` 的日志模板里就有）。
 */
export function stripComments(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');
}

/** 纯函数，便于单测。返回 null 表示通过，否则返回失败原因。 */
export function checkBootstrap(source: string): string | null {
  const code = stripComments(source);
  if (!/\.enableShutdownHooks\s*\(/.test(code)) {
    return '缺 `app.enableShutdownHooks()` — prod 收到 SIGTERM 时所有关停钩子都不会跑';
  }
  // 必须在 listen() 之前调用：listen 之后才注册，存在「已开始收流量但钩子未挂」的窗口。
  const hookAt = code.search(/\.enableShutdownHooks\s*\(/);
  const listenAt = code.search(/\.listen\s*\(/);
  if (listenAt >= 0 && hookAt > listenAt) {
    return '`enableShutdownHooks()` 出现在 `listen()` 之后 — 应在开始收流量前挂好';
  }
  return null;
}

function main(): void {
  const path = join(REPO_ROOT, MAIN_TS);
  if (!existsSync(path)) {
    console.error(`❌ check-shutdown-hooks: 找不到 ${MAIN_TS}`);
    process.exit(1);
  }
  const reason = checkBootstrap(readFileSync(path, 'utf8'));
  if (reason) {
    console.error(`❌ check-shutdown-hooks failed:\n\n  - ${MAIN_TS}: ${reason}\n`);
    console.error('Fix: 在 `await app.listen(...)` 之前加 `app.enableShutdownHooks();`。');
    console.error('     并核对 docker-compose.tight.yml 的 `stop_grace_period` 是否覆盖关停预算');
    console.error('     （否则等是假的，到点照样 SIGKILL）。背景见 issue #824。');
    process.exit(1);
  }
  console.log('✅ check-shutdown-hooks: main.ts 在 listen() 前调用了 enableShutdownHooks()。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
