#!/usr/bin/env node
/**
 * fetch-tzzb.ts — 同花顺投资账本（tzzb.10jqka.com.cn）持仓导出拉取段（025 T018, FR-012）。
 *
 * 方案：**自写最小 CDP 客户端**驱动本机调试 Chrome（固定 profile 持久登录态）。Chrome 未起则带
 * `--remote-debugging-port` + 固定 profile 启动并提示人工登录（首跑一次，之后 profile 复用登录态
 * + 由保存的账户 URL 直达目标账户页）。**拉取完即关掉本次拉起的调试 Chrome**（见 `fetchTzzb`
 * finally）——避免残留的 tzzb SPA 页面整天向同花顺后端轮询；登录态存活在落盘 profile 而非进程，
 * 下次启动用同 profile 直接复用，不丢登录。
 *
 * 🚨 **为什么不再用 playwright `connectOverCDP`（2026-09-21 换掉）**
 *
 * tzzb 页面引入了开源库 `disable-devtool@0.3.9`，命中即把 `document` 整个换成「当前页面不支持
 * 开发者工具，请关闭后刷新页面」，导出按钮随之消失。
 * EVIDENCE: 站点 bundle `https://s.thsi.cn/cd/xcs-tzzb-front-app-pc/static/js/index.90639d4d.js`
 *   内向该库传入 `{md5, disableMenu:false, rewriteHTML:"…"}`三个参数（md5 是库自带的
 *   开发者旁路 token 的哈希，字面值见 bundle，本仓不复制——32 位 hex 会被 `check-identifier-boundary`
 *   当成账号 ID 拦下），
 *   库本体在同站 `static/js/vendor..pnpm.e9683cd9.js`（`version:"0.3.9"`，`detectors` 默认
 *   `[1,3,4,5,6,7]`，站点未覆盖该项）。2026-09-21 实取。
 *
 * 触发的**只有** `Performance(6)` 这一个探测器——它比较 `console.table` 与 `console.log` 的耗时，
 * 有 console 消费者时前者被序列化推送、耗时拉开 >10 倍即判定「devtools 开着」。
 * EVIDENCE: 2026-09-21 受控实验，同版本真库 + 同 detector 配置 + 本机 Chrome 153.0.8010.48，
 *   仅变量为「是否发送 `Runtime.enable`」：不发 → 26 次 tick 零命中；发 → 命中且仅命中
 *   `6=Performance`。同实验中 `DefineId(1)` / `DateToString(3)` / `FuncToString(4)` 三个 getter 类
 *   探测器**均未命中**（Chrome M137+ 的 V8 补丁使 CDP 对象预览不再调用页面 getter）。
 *
 * playwright 的 `connectOverCDP` 会自动 `Runtime.enable` 并订阅 `consoleAPICalled`，于是必中。
 * ⇒ 本文件只使用 `Browser` / `Page` / `DOM` / `Input` 四个域，**MUST NOT 发送任何 `Runtime.*`**。
 *   改动前先重跑上面那个受控实验，别凭直觉加域。
 *
 * 导出：`DOM.performSearch` 定位「数据导出」→ `DOM.getBoxModel` 取中心点 → `Input.dispatchMouseEvent`
 * 点击 → `Browser.setDownloadBehavior` 把文件落到暂存目录 → 轮询暂存目录收件。
 *
 * 为何走浏览器原生下载而非自拼 note/download URL（早期方案已废）：tzzb 导出后端按当前账户的
 * fund_key 生成「持仓数据 / 已清仓 / 交易记录」3-sheet 文件并触发浏览器原生下载；自己捕获
 * `/excel/` 请求参数再拼 note 轮询 + download URL 的做法会因 ① 多账户 fund_key 差异
 * ② 按 tab 分批触发请求的 race，抓到残缺文件（实测丢「持仓数据」sheet）。原生下载拿到的就是与
 * 「网页手动导出」逐字节同源的完整文件，零参数重建、零硬编码。整链（点击→下载）失败重试 ×3。
 *
 * 账户选择：首跑在 Chrome 里切到目标账户（如「股票账户」）的「持仓列表」页一次；成功导出后
 * 脚本把该账户页 URL（含 hash）记到 `~/.nvy/holdings-sync/tzzb-account.json`，之后每次启动
 * 直达该 URL —— 不怕 tab 飘到别的账户、不怕窗口看不到，headless 定时也因此稳定。交互态找不到
 * 按钮时会把 Chrome 窗口叫到前台并打印当前页面，方便人工处置。
 *
 * Usage:
 *   pnpm holdings:fetch        # 单跑拉取段（交互：未登录则提示）
 *   pnpm holdings:fetch --headless   # 非交互（定时）：找不到导出按钮即抛错不 prompt
 *   pnpm holdings:sync         # 拉取 + 上传一键（推荐）
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const CDP_PORT = 18800;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_PROFILE = join(homedir(), '.nvy', 'chrome-tzzb-profile');
const DOWNLOAD_DIR = join(homedir(), '.nvy', 'holdings-sync');
// 浏览器原生下载的落点；收完即把文件搬进 DOWNLOAD_DIR 并补日期后缀。单独一层免与历史 xlsx 混淆
const STAGING_DIR = join(DOWNLOAD_DIR, '.staging');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 冷启动落地页（不含账户 hash——账户由持久 profile 记忆，硬编码 hash 会失效/串户）
const TZZB_URL = 'https://tzzb.10jqka.com.cn/pc/index.html';
const TZZB_HOST = 'tzzb.10jqka.com.cn';
const EXPORT_BUTTON_TEXT = '数据导出';
// 反调试封页的特征文案（见顶部 EVIDENCE）；用于把「页面被改写」与「真没登录」分开报错
const ANTI_DEVTOOL_MARK = '不支持开发者工具';

const EXPORT_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 20_000;
const BUTTON_TIMEOUT_MS = 30_000;
// 记住「成功导出过的账户页 URL」（含账户 hash）——下次启动直达该页，不怕 tab 飘到别的账户/站
const ACCOUNT_CONFIG_PATH = join(DOWNLOAD_DIR, 'tzzb-account.json');

// ────────────────────────────── 最小 CDP 客户端 ──────────────────────────────

type CdpParams = Record<string, unknown>;
type CdpResult = Record<string, unknown>;

interface CdpClient {
  send(method: string, params?: CdpParams): Promise<CdpResult>;
  close(): void;
}

/**
 * 裸 WebSocket CDP 客户端（Node 22 自带全局 `WebSocket`，零依赖）。
 *
 * 只做三件事：发命令、按 id 配对回包、连接断开时把所有在途请求 reject（不 reject 会让进程挂死在
 * 一个永不 settle 的 promise 上——这正是旧实现崩溃的同源问题）。**不订阅任何事件**。
 */
async function cdpConnect(wsUrl: string): Promise<CdpClient> {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map<number, { ok: (r: CdpResult) => void; err: (e: Error) => void }>();
  let closed: Error | undefined;

  const settleAllAsFailed = (reason: Error) => {
    closed ??= reason;
    for (const { err } of pending.values()) err(reason);
    pending.clear();
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: CdpResult;
      error?: { message?: string };
    };
    if (typeof msg.id !== 'number') return; // 事件包：本客户端不订阅事件，直接丢弃
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.error) slot.err(new Error(`CDP 错误: ${msg.error.message ?? '未知'}`));
    else slot.ok(msg.result ?? {});
  };
  ws.onclose = () => settleAllAsFailed(new Error('CDP 连接已关闭'));

  // 握手期单独接管 onopen/onerror；成功后再挂上长期的 onerror。
  // 超时定时器必须 clear：不 clear 会在 10s 后对一个已 settle 的 promise 再调 reject（无害），
  // 但更关键的是它会把进程多吊活 10 秒。
  await new Promise<void>((res, rej) => {
    const timer = setTimeout(() => rej(new Error(`CDP 握手超时: ${wsUrl}`)), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      res();
    };
    ws.onerror = () => {
      clearTimeout(timer);
      rej(new Error(`CDP 握手失败: ${wsUrl}`));
    };
  });
  ws.onerror = () => settleAllAsFailed(new Error('CDP 连接出错'));

  return {
    send(method, params = {}) {
      if (closed) return Promise.reject(closed);
      const id = ++nextId;
      return new Promise<CdpResult>((ok, err) => {
        pending.set(id, { ok, err });
        ws.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      try {
        ws.close();
      } catch {
        // 关不掉也无所谓：下面 killDebugChrome 会兜底
      }
    },
  };
}

// ────────────────────────────── 账户记忆 / Chrome 生命周期 ──────────────────────────────

async function loadSavedAccountUrl(): Promise<string | undefined> {
  try {
    const { url } = JSON.parse(await readFile(ACCOUNT_CONFIG_PATH, 'utf8')) as { url?: string };
    return typeof url === 'string' && url.includes(TZZB_HOST) ? url : undefined;
  } catch {
    return undefined;
  }
}

async function saveAccountUrl(url: string): Promise<void> {
  if (!url.includes(TZZB_HOST)) return;
  try {
    await mkdir(DOWNLOAD_DIR, { recursive: true });
    await writeFile(ACCOUNT_CONFIG_PATH, `${JSON.stringify({ url }, null, 2)}\n`);
  } catch {
    // 记忆尽力而为——存不下不该阻断主流程
  }
}

/** 把已运行的调试 Chrome 窗口叫到前台（CLI spawn 出来的窗口默认不抢焦点/可能在别的 Space）。 */
function bringChromeToFront(): void {
  if (process.platform !== 'darwin') return;
  spawnSync('osascript', ['-e', 'tell application "Google Chrome" to activate'], {
    stdio: 'ignore',
  });
}

async function cdpAvailable(): Promise<boolean> {
  try {
    const resp = await fetch(`${CDP_BASE}/json/version`, { signal: AbortSignal.timeout(2_000) });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * 带固定 profile 启动调试 Chrome（detached；登录态落盘 profile，拉取完由 fetchTzzb 关闭，不丢登录）。
 *
 * 直接把目标 URL 作为启动参数——省掉一次 `Page.navigate`，也就省掉「等导航完成」所需的 `Page` 域
 * 事件订阅。落地后是否就位由 `waitForExportButton` 轮询 DOM 判定。
 */
async function launchChrome(landingUrl: string): Promise<void> {
  console.log(`启动 Chrome（固定 profile: ${CHROME_PROFILE}）...`);
  await mkdir(CHROME_PROFILE, { recursive: true });
  spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      landingUrl,
    ],
    { detached: true, stdio: 'ignore' },
  ).unref();

  for (let i = 0; i < 30; i++) {
    await sleep(1_000);
    if (await cdpAvailable()) {
      console.log('Chrome 已启动');
      return;
    }
  }
  throw new Error(`Chrome 启动失败：${CDP_PORT} 端口 30s 内未就绪`);
}

/** 只杀用 tzzb 固定 profile 起的调试 Chrome（按 user-data-dir 精确匹配，绝不误伤主 Chrome）。 */
function killDebugChrome(): void {
  // 模式不以 '-' 开头免被 pkill 当选项解析；profile 路径全局唯一 → 仅命中本调试 Chrome 进程树
  spawnSync('pkill', ['-f', `user-data-dir=${CHROME_PROFILE}`], { stdio: 'ignore' });
}

/** 取 tzzb 页 target 的 WebSocket 调试地址；没有则返回 undefined。 */
async function findTzzbTarget(): Promise<{ ws: string; url: string } | undefined> {
  const list = (await (await fetch(`${CDP_BASE}/json/list`)).json()) as {
    type: string;
    url: string;
    webSocketDebuggerUrl?: string;
  }[];
  const t = list.find((x) => x.type === 'page' && x.url.includes(TZZB_HOST));
  return t?.webSocketDebuggerUrl ? { ws: t.webSocketDebuggerUrl, url: t.url } : undefined;
}

// ────────────────────────────── 页面操作（只用 DOM / Input） ──────────────────────────────

/** 在当前页里找含给定文案的可见节点，返回其中心点；找不到返回 undefined。 */
async function findVisibleTextCenter(
  cdp: CdpClient,
  text: string,
): Promise<{ x: number; y: number } | undefined> {
  await cdp.send('DOM.getDocument', { depth: -1 });
  const search = (await cdp.send('DOM.performSearch', { query: text })) as {
    searchId: string;
    resultCount: number;
  };
  if (!search.resultCount) return undefined;
  const got = (await cdp.send('DOM.getSearchResults', {
    searchId: search.searchId,
    fromIndex: 0,
    toIndex: Math.min(search.resultCount, 10),
  })) as { nodeIds: number[] };
  for (const nodeId of got.nodeIds ?? []) {
    const bm = (await cdp.send('DOM.getBoxModel', { nodeId }).catch(() => ({}))) as {
      model?: { content: number[] };
    };
    const q = bm.model?.content;
    if (!q) continue; // 不可见 / 已脱离布局
    return { x: (q[0] + q[2] + q[4] + q[6]) / 4, y: (q[1] + q[3] + q[5] + q[7]) / 4 };
  }
  return undefined;
}

/** 页面是否已被反调试封页改写（见顶部 EVIDENCE）。 */
async function isAntiDevtoolBlocked(cdp: CdpClient): Promise<boolean> {
  try {
    await cdp.send('DOM.getDocument', { depth: -1 });
    const s = (await cdp.send('DOM.performSearch', { query: ANTI_DEVTOOL_MARK })) as {
      resultCount: number;
    };
    return s.resultCount > 0;
  } catch {
    return false;
  }
}

/**
 * 等「数据导出」按钮出现，返回其中心点。
 * - headless（定时）：等不到即抛错——**不** prompt（无 TTY 会挂死）。报错分两种，别再一律甩锅登录态。
 * - 交互：提示人工登录/切账户后回车重试。
 */
async function waitForExportButton(
  cdp: CdpClient,
  interactive: boolean,
  pageUrl: string,
): Promise<{ x: number; y: number }> {
  const poll = async (): Promise<{ x: number; y: number } | undefined> => {
    const deadline = Date.now() + BUTTON_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const c = await findVisibleTextCenter(cdp, EXPORT_BUTTON_TEXT);
      if (c) return c;
      await sleep(500);
    }
    return undefined;
  };

  let center = await poll();
  if (center) return center;

  // 🚨 找不到按钮有两个完全不同的原因，旧实现一律报「登录态过期」，2026-09-11 起把排查带偏了 11 天
  const blockedFirst = await isAntiDevtoolBlocked(cdp);
  if (blockedFirst) {
    throw new Error(
      `页面被反调试封页改写（含「${ANTI_DEVTOOL_MARK}」），不是登录态问题。` +
        '本脚本不应触发它——请核对是否有别的客户端 attach 了这个调试 Chrome 并开启了 Runtime 域（见本文件顶部 EVIDENCE）。',
    );
  }
  if (!interactive) {
    throw new Error(
      `未检测到「${EXPORT_BUTTON_TEXT}」按钮，且页面未被反调试封页（当前页：${pageUrl}）：` +
        '同花顺登录态可能已过期。请手动重新登录：pnpm holdings:fetch（或 pnpm holdings:setup）',
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      bringChromeToFront(); // 把窗口叫到前台，免得用户找不到（CLI 启的窗口不抢焦点）
      console.log(`未检测到「${EXPORT_BUTTON_TEXT}」按钮。当前页面：${pageUrl}`);
      console.log(
        '已把调试 Chrome 调到前台——请登录并切到目标账户（如「股票账户」）的「持仓列表」页。',
      );
      await rl.question('切好后回车重试 > ');
      center = await poll();
      if (center) return center;
    }
  } finally {
    rl.close();
  }
  throw new Error(`多次重试后仍未找到「${EXPORT_BUTTON_TEXT}」按钮`);
}

/** 暂存目录里第一个下载完成的文件（`.crdownload` 是 Chrome 的半成品后缀）。 */
async function firstCompletedDownload(): Promise<string | undefined> {
  const names = await readdir(STAGING_DIR).catch(() => [] as string[]);
  return names.find((n) => !n.endsWith('.crdownload') && !n.startsWith('.'));
}

/**
 * 点击导出 → 轮询暂存目录收件 → 搬进 DOWNLOAD_DIR 并补日期后缀，返回最终路径。
 *
 * 🚨 全程**零悬挂 promise**：旧实现先创建 `page.waitForEvent('download')` 再 `click()`，click 抛错时
 * 那个 promise 无人 await，20 秒后以未捕获 rejection 打爆进程，`finally` 不执行 ⇒ 调试 Chrome 泄漏
 * ⇒ 次日复用到这个停在封页上的实例，报出误导性的「登录态过期」。改成「先点，再轮询文件系统」后
 * 不存在任何未 await 的 promise。
 */
async function exportViaDownload(
  cdp: CdpClient,
  center: { x: number; y: number },
): Promise<string> {
  await rm(STAGING_DIR, { recursive: true, force: true });
  await mkdir(STAGING_DIR, { recursive: true });

  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'] as const) {
    await cdp.send('Input.dispatchMouseEvent', {
      type,
      x: center.x,
      y: center.y,
      button: 'left',
      clickCount: type === 'mouseMoved' ? 0 : 1,
    });
  }
  console.log(`已点击「${EXPORT_BUTTON_TEXT}」按钮，等待下载...`);

  const deadline = Date.now() + DOWNLOAD_TIMEOUT_MS;
  let suggested: string | undefined;
  while (Date.now() < deadline) {
    await sleep(500);
    suggested = await firstCompletedDownload();
    if (suggested) break;
  }
  if (!suggested) {
    throw new Error(`点击后 ${DOWNLOAD_TIMEOUT_MS / 1000}s 内没有下载完成的文件落入暂存目录`);
  }

  // suggested 形如「股票账户.xlsx」（账户名，无日期）→ 拼上 YYYYMMDD 供上传段取 asOf
  const stem = suggested.replace(/\.xlsx$/i, '') || '持仓';
  const now = new Date();
  const yyyymmdd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const outputPath = join(DOWNLOAD_DIR, `${stem}_${yyyymmdd}.xlsx`);
  await rename(join(STAGING_DIR, suggested), outputPath);
  console.log(`下载完成: ${outputPath}（来源「${suggested}」）`);
  return outputPath;
}

// ────────────────────────────── 入口 ──────────────────────────────

/** 拉取段入口：返回落盘的 xlsx 绝对路径。interactive=false 时登录失效快速抛错（定时用）。 */
export async function fetchTzzb(
  opts: { interactive: boolean } = { interactive: true },
): Promise<string> {
  const landingUrl = (await loadSavedAccountUrl()) ?? TZZB_URL;

  // 复用已在跑的调试 Chrome 有个隐患：它可能停在任意页面（历史上还停在过反调试封页）。
  // 这里不再盲目复用——没有 tzzb 页 target 就当它不可用，杀掉重开一个干净的。
  if (await cdpAvailable()) {
    console.log(`CDP 已可用（${CDP_BASE}）`);
    if (!(await findTzzbTarget())) {
      console.warn('已有调试 Chrome 里没有 tzzb 页，杀掉重开一个干净实例');
      killDebugChrome();
      for (let i = 0; i < 10 && (await cdpAvailable()); i++) await sleep(500);
      await launchChrome(landingUrl);
    }
  } else {
    await launchChrome(landingUrl);
  }

  const target = await findTzzbTarget();
  if (!target) throw new Error('调试 Chrome 已就绪但找不到 tzzb 页 target');

  const version = (await (await fetch(`${CDP_BASE}/json/version`)).json()) as {
    webSocketDebuggerUrl: string;
  };
  const browserCdp = await cdpConnect(version.webSocketDebuggerUrl);
  const pageCdp = await cdpConnect(target.ws);

  try {
    await browserCdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: STAGING_DIR,
    });
    await pageCdp.send('DOM.enable');

    const center = await waitForExportButton(pageCdp, opts.interactive, target.url);

    let lastError: unknown;
    for (let attempt = 1; attempt <= EXPORT_RETRIES; attempt++) {
      try {
        const outputPath = await exportViaDownload(pageCdp, center);
        await saveAccountUrl(target.url); // 记住成功导出的账户页，下次（含 headless）直达
        return outputPath;
      } catch (err) {
        lastError = err;
        console.error(
          `导出失败（${attempt}/${EXPORT_RETRIES}）:`,
          err instanceof Error ? err.message : err,
        );
        if (attempt < EXPORT_RETRIES) await sleep(10_000);
      }
    }
    throw new Error(
      `导出重试 ${EXPORT_RETRIES} 次均失败，最后错误: ${lastError instanceof Error ? lastError.message : lastError}`,
    );
  } finally {
    // 拉取段是浏览器的唯一用途，用完即关：成功 / 失败都走到这里，杜绝残留 tzzb SPA 页整天向同花顺
    // 后端轮询。登录态存活在落盘 profile（非进程），关掉进程不丢登录，下次冷启复用同 profile。
    //
    // 关法分两步、缺一不可：
    // ① 优雅关（CDP `Browser.close`）—— 走 Chrome 正常关闭路径，**立即把本次会话可能轮转的登录
    //    cookie 落盘**。实测 macOS Chrome 在 `pkill` SIGTERM 下并不 flush（写入后 < commit timer
    //    就被杀会丢盘上数据），仅优雅关 / 越过 ~30s commit timer 才落盘 —— 故必须优雅关保登录。
    // ② killDebugChrome 兜底 —— 优雅关失败（CDP 已断 / 实例 rot）或仍有残留时，按 user-data-dir
    //    精确终结（绝不误伤主 Chrome），保证「零残留进程」这条硬约束。
    await browserCdp.send('Browser.close').catch(() => {});
    pageCdp.close();
    browserCdp.close();
    await sleep(1_000); // 给 Chrome 走完关闭流程、把 cookie 落盘的时间
    killDebugChrome();
    await rm(STAGING_DIR, { recursive: true, force: true }).catch(() => {});
  }
}

/** 交互 = 有 TTY 且未显式 --headless（定时任务无 TTY 自动判为非交互）。 */
export function isInteractive(argv: string[]): boolean {
  return Boolean(process.stdin.isTTY) && !argv.includes('--headless');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // 🚨 进程级兜底：任何漏网的未捕获异常都必须先关掉调试 Chrome 再退出，否则残留实例会污染下一跑
  // （历史故障就是这么来的，见 exportViaDownload 的注释）。
  for (const sig of ['uncaughtException', 'unhandledRejection'] as const) {
    process.on(sig, (err: unknown) => {
      console.error(`未捕获异常（${sig}）:`, err instanceof Error ? err.message : err);
      killDebugChrome();
      process.exit(1);
    });
  }
  fetchTzzb({ interactive: isInteractive(process.argv.slice(2)) })
    .then((path) => {
      console.log(path);
      process.exit(0); // CDP 连接挂着 event loop，显式退出
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      console.error(
        '提示：首次运行需在 Chrome 中人工登录同花顺并切到目标账户持仓页，之后重跑即可。',
      );
      killDebugChrome();
      process.exit(1);
    });
}
