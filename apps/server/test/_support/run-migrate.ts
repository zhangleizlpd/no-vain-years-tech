import { execFileSync } from 'node:child_process';

/**
 * 跑一次 `prisma migrate deploy`（给 `setupEmptyDb()` 那类「自己要 migrate 并验证其产物」
 * 的 spec 用）——**成功即弃输出，失败即连输出一起抛**。
 *
 * ## 为什么要有这个 helper
 *
 * 原本 7 个 `*.schema.it.spec.ts` 各自 `execFileSync(..., { stdio: 'inherit' })`，每个都把
 * 完整 migration 树打一遍 —— 本地一轮 ~1000 行 / 52KB 纯噪声，而且随 migration 数量单调增长。
 *
 * 这不是洁癖，是**可诊断性**：GitHub 的 job log 端点只回一个有限窗口，噪声挤掉的正是失败时
 * 真要看的东西。2026-08-17 实撞 —— `server-test` 在 CI 上连续两次红，而日志里连 vitest 的
 * 汇总行都取不到（对照一次**成功**的跑，同样取不到 ⇒ 是端点行为，不是那次异常）。
 *
 * ## 🚨 用 `pipe` 而不是 `ignore`
 *
 * `global-setup.ts` 那处用 `ignore` 是因为它跑在 vitest 生命周期外、失败会以别的方式响。
 * 这里不同：`ignore` 会在 migrate 真失败时把**唯一的线索**也丢掉，只剩一个 exit code。
 * `pipe` 两个方向都不亏 —— 正常路径零输出，失败路径把 stdout/stderr 原样带进异常消息。
 *
 * @param databaseUrl 覆盖 `DATABASE_URL`；不传则沿用 `process.env`（多数调用点在此之前
 *                    已经 `process.env.DATABASE_URL = db.databaseUrl`）。
 */
export function runMigrateDeploy(databaseUrl?: string): void {
  try {
    execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'deploy'], {
      // 必须在 apps/server 下跑，prisma 才找得到 schema。vitest 的 cwd 就是它。
      cwd: process.cwd(),
      env: databaseUrl ? { ...process.env, DATABASE_URL: databaseUrl } : process.env,
      stdio: 'pipe',
    });
  } catch (err) {
    const e = err as { stdout?: Buffer; stderr?: Buffer };
    throw new Error(
      [
        'prisma migrate deploy 失败（输出由 run-migrate helper 捕获后原样附上）',
        '--- stdout ---',
        e.stdout?.toString() ?? '(空)',
        '--- stderr ---',
        e.stderr?.toString() ?? '(空)',
      ].join('\n'),
      { cause: err },
    );
  }
}
