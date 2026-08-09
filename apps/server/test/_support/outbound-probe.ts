/**
 * 出网探针 —— 用**运行时**证据校验 `docs/conventions/testing.md` 的 size 判据。
 *
 * 为什么需要它：`scripts/checks/check-test-size.ts` 是**静态**扫 import 的，它原理上
 * 看不见「动态 require 进来的客户端」「某个 lib 内部自己发的请求」这类出网。也就是说
 * 静态守卫对「Small 真的零外部依赖」只能给出必要条件，给不出充分条件。
 * 探针补的正是这一半：直接拦 socket / DNS / 子进程，记录**实际发生**的出网。
 *
 * 默认不挂（零成本）。开启：
 *   NVY_OUTBOUND_PROBE=1 pnpm exec nx test server --skip-nx-cache -- --project unit
 *   然后读 apps/server/.outbound-probe.jsonl
 *
 * 判据（对应 testing.md §2 三档）：
 *   Small  (`--project unit`) → 文件应为空：**零条**记录
 *   Medium (`--project it`)   → 只允许 loopback（127.0.0.1 / ::1 / localhost）
 *   Large  (`*.vendor.spec.ts`) → 默认 skip，故默认跑也应零记录
 */
import net from 'node:net';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = resolve(process.cwd(), '.outbound-probe.jsonl');

/**
 * 记录一条。**必须带归因**（`at` + `detail`）—— 一条无法归因的记录就足以推翻
 * 「零出网」的结论，而没有调用栈就查不出它是被测代码还是 runner 自身的 IPC。
 */
function record(kind: string, target: string, detail?: unknown): void {
  // 留多帧：真正的调用方常常整条栈都在 node_modules 里（如 runner 自身的 IPC），
  // 只找「第一个非 node_modules 帧」会退化成探针自己，等于没归因。
  const frames = (new Error().stack ?? '')
    .split('\n')
    .slice(2)
    .map((l) => l.trim())
    .filter((l) => !l.includes('outbound-probe.ts'))
    .slice(0, 4);
  const at = frames.join(' | ') || '(no frame)';
  // 归到**具体哪个 spec 文件** —— 没有它就只知道「有人连了外面」，查不出是谁，
  // 而 vitest 并行跑时调用栈里根本不含 spec 路径（连接常发生在库内部的异步 tick 上）。
  let spec = '(unknown)';
  try {
    // globals: true ⇒ expect 在 worker 全局可用；getState().testPath 是当前 spec 绝对路径。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    spec = (globalThis as any).expect?.getState?.()?.testPath ?? '(unknown)';
  } catch {
    /* 探针不负责解释拿不到的情况 */
  }
  // 逐行追加而非攒在内存里：worker 被 kill 时也不丢证据。
  try {
    appendFileSync(OUT, JSON.stringify({ kind, target, spec, at, detail }) + '\n');
  } catch {
    // 探针自身绝不能让被测进程失败 —— 它只是观测者。
  }
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|::1|localhost|0\.0\.0\.0)$/;

// 1) TCP —— Testcontainers 映射到宿主的端口也走这里（host 会是 127.0.0.1）。
const origConnect = net.Socket.prototype.connect;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
net.Socket.prototype.connect = function patched(this: net.Socket, ...args: any[]) {
  // Node 内部会用 `normalizeArgs()` 把参数折成 `[options, cb]` 再调本方法，故先拆包 ——
  // 不拆的话记录里全是 `?:` 这种无法归因的条目（2026-08-02 第一版实撞，见 improvements 记录）。
  const raw = args[0];
  const opts = Array.isArray(raw) ? raw[0] : raw;
  const isObj = typeof opts === 'object' && opts !== null;
  // `connect(path)`（unix socket / IPC）与 `connect(port, host)` 两种非对象签名要分开认，
  // 否则 IPC 会被记成 `?:` 这种无法归因的记录（2026-08-02 第一版就是这样，见 improvements 记录）。
  const isIpcPath = isObj ? typeof opts.path === 'string' : typeof opts === 'string';
  const host = isObj ? String(opts.host ?? opts.path ?? '?') : String(args[1] ?? '?');
  const port = isObj ? String(opts.port ?? '') : String(opts);
  const kind = isIpcPath ? 'ipc-socket' : LOOPBACK.test(host) ? 'tcp-loopback' : 'tcp-remote';
  record(kind, `${host}:${port}`, isObj ? Object.keys(opts) : typeof opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origConnect as any).apply(this, args);
};

// 2) DNS —— 出网前一步。解析非 loopback 名字本身就说明打算连外面。
const origLookup = dns.lookup;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(dns as any).lookup = function patched(hostname: string, ...rest: any[]) {
  if (!LOOPBACK.test(hostname)) record('dns', hostname);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origLookup as any)(hostname, ...rest);
};

// 3) 子进程 —— Small 禁起第三方程序（`prisma migrate deploy` / `docker` 都在此列）。
for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync'] as const) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const orig = (childProcess as any)[fn];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (childProcess as any)[fn] = function patched(cmd: any, ...rest: any[]) {
    record('child-process', String(cmd));
    return orig(cmd, ...rest);
  };
}
