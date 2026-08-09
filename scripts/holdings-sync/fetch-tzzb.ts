#!/usr/bin/env node
/**
 * fetch-tzzb.ts — 同花顺投资账本（tzzb.10jqka.com.cn）持仓导出拉取段（025 T018, FR-012）。
 *
 * 方案：playwright `connectOverCDP` 驱动本机调试 Chrome（固定 profile 持久登录态）。Chrome 未起
 * 则带 `--remote-debugging-port` + 固定 profile 启动并提示人工登录（首跑一次，之后 profile 复用
 * 登录态 + 由保存的账户 URL 直达目标账户页）。**拉取完即杀掉本次拉起的调试 Chrome**（见
 * `fetchTzzb` finally）——避免残留的 tzzb SPA 页面整天向同花顺后端轮询；登录态存活在落盘 profile
 * 而非进程，下次启动用同 profile 直接复用，不丢登录。
 *
 * 导出：点页面「数据导出」按钮 → **监听浏览器原生下载事件**（`page.on('download')`）→
 * `download.saveAs` 落盘 `~/.nvy/holdings-sync/<账户名>_YYYYMMDD.xlsx`。
 *
 * 为何走原生下载而非自拼 note/download URL（早期方案已废）：tzzb 导出后端按当前账户的
 * fund_key 生成「持仓数据 / 已清仓 / 交易记录」3-sheet 文件并触发浏览器原生下载；自己捕获
 * `/excel/` 请求参数再拼 note 轮询 + download URL 的做法会因 ① 多账户 fund_key 差异
 * ② 按 tab 分批触发请求的 race，抓到残缺文件（实测丢「持仓数据」sheet）。原生下载事件拿到
 * 的就是与「网页手动导出」逐字节同源的完整文件，零参数重建、零硬编码。
 * 整链（点击→下载）失败重试 ×3。
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
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
// playwright-core：仅驱动系统 Chrome（connectOverCDP），免下载 bundled browser（自包含可移植）
import { chromium, type Browser, type Locator, type Page } from 'playwright-core';

const CDP_PORT = 18800;
const CDP_BASE = `http://127.0.0.1:${CDP_PORT}`;
const CHROME_PROFILE = join(homedir(), '.nvy', 'chrome-tzzb-profile');
const DOWNLOAD_DIR = join(homedir(), '.nvy', 'holdings-sync');
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// 冷启动落地页（不含账户 hash——账户由持久 profile 记忆，硬编码 hash 会失效/串户）
const TZZB_URL = 'https://tzzb.10jqka.com.cn/pc/index.html';
const TZZB_HOST = 'tzzb.10jqka.com.cn';

const EXPORT_RETRIES = 3;
const DOWNLOAD_TIMEOUT_MS = 20_000;
// 记住「成功导出过的账户页 URL」（含账户 hash）——下次启动直达该页，不怕 tab 飘到别的账户/站
const ACCOUNT_CONFIG_PATH = join(DOWNLOAD_DIR, 'tzzb-account.json');

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

/** 带固定 profile 启动调试 Chrome（detached；登录态落盘 profile，拉取完由 fetchTzzb 杀本进程，不丢登录）。 */
async function launchChrome(): Promise<void> {
  console.log(`启动 Chrome（固定 profile: ${CHROME_PROFILE}）...`);
  await mkdir(CHROME_PROFILE, { recursive: true });
  spawn(
    CHROME_PATH,
    [
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${CHROME_PROFILE}`,
      '--no-first-run',
      '--no-default-browser-check',
      TZZB_URL,
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

/**
 * 连上调试 Chrome，并对「已有实例 rot 成坏 CDP 状态」自愈。
 *
 * `cdpAvailable()` 只探 /json/version，会被 rot 的 Chrome 骗过（端口答得上但 CDP 已坏）——
 * 故真正的健康检查就是 connectOverCDP 本身。端口就绪却连接失败（实测过的
 * `Browser context management is not supported`，见 06-11 / 06-26 sync.log）→ 杀掉这个坏调试
 * Chrome、重启一个干净的、再连一次。一次自愈足够；仍失败则抛（让上层 fail → 飞书告警）。
 */
async function connectOrHeal(): Promise<Browser> {
  if (await cdpAvailable()) {
    console.log(`CDP 已可用（${CDP_BASE}）`);
  } else {
    await launchChrome();
  }
  try {
    return await chromium.connectOverCDP(CDP_BASE);
  } catch (err) {
    console.warn(`连接调试 Chrome 失败，杀掉重启再试：${err instanceof Error ? err.message : err}`);
    killDebugChrome();
    // 等旧实例释放 18800（端口仍被占则新实例起不来）
    for (let i = 0; i < 10 && (await cdpAvailable()); i++) await sleep(500);
    await launchChrome();
    return await chromium.connectOverCDP(CDP_BASE);
  }
}

/**
 * 在已 attach 的浏览器里拿到 tzzb 页，并尽量落到正确账户：
 * - 记过账户 URL（成功导出过）→ 直达该 URL（精确落到「股票账户 持仓列表」，不怕 tab 飘）。
 * - 没记过 → 仅当当前页不在 tzzb 时才开基础首页（不打扰用户已切好的页）。
 */
async function getTzzbPage(browser: Browser): Promise<Page> {
  const pages = browser.contexts().flatMap((c) => c.pages());
  const page =
    pages.find((p) => p.url().includes(TZZB_HOST)) ??
    pages[0] ??
    (await browser.contexts()[0]?.newPage());
  if (!page) throw new Error('CDP attach 成功但无可用页面');

  const savedUrl = await loadSavedAccountUrl();
  if (savedUrl) {
    if (page.url() !== savedUrl) await page.goto(savedUrl, { waitUntil: 'domcontentloaded' });
  } else if (!page.url().includes(TZZB_HOST)) {
    await page.goto(TZZB_URL, { waitUntil: 'domcontentloaded' });
  }
  return page;
}

/**
 * 等「数据导出」按钮出现。
 * - headless（定时）：等不到即抛错（同花顺登录态多半过期）——**不** prompt（无 TTY 会挂死）。
 * - 交互：提示人工登录/切账户后回车重试（reload 保留当前账户 hash）。
 */
async function waitForExportButton(page: Page, interactive: boolean): Promise<Locator> {
  const button = page.getByText('数据导出', { exact: true }).first();
  if (!interactive) {
    try {
      await button.waitFor({ state: 'visible', timeout: 30_000 });
      return button;
    } catch {
      throw new Error(
        '未检测到「数据导出」按钮：同花顺登录态可能已过期。请手动重新登录：pnpm holdings:fetch（或 pnpm holdings:setup）',
      );
    }
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await button.waitFor({ state: 'visible', timeout: 30_000 });
        return button;
      } catch {
        bringChromeToFront(); // 把窗口叫到前台，免得用户找不到（CLI 启的窗口不抢焦点）
        console.log(`未检测到「数据导出」按钮。当前页面：${page.url()}`);
        console.log(
          '已把调试 Chrome 调到前台——请登录并切到目标账户（如「股票账户」）的「持仓列表」页。',
        );
        await rl.question('切好后回车重试 > ');
        await page.reload({ waitUntil: 'domcontentloaded' }); // reload 不重导航，保留当前账户 hash
      }
    }
  } finally {
    rl.close();
  }
  throw new Error('多次重试后仍未找到「数据导出」按钮');
}

/** 点击导出 → 监听原生下载事件 → saveAs 落盘，返回路径。 */
async function exportViaDownload(page: Page, button: Locator): Promise<string> {
  const downloadPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT_MS });
  await button.click();
  console.log('已点击「数据导出」按钮，等待下载...');
  const download = await downloadPromise;

  // suggestedFilename 形如「股票账户.xlsx」（账户名，无日期）→ 拼上 YYYYMMDD 供上传段取 asOf
  const suggested = download.suggestedFilename();
  const stem = suggested.replace(/\.xlsx$/i, '') || '持仓';
  const now = new Date();
  const yyyymmdd = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('');

  await mkdir(DOWNLOAD_DIR, { recursive: true });
  const outputPath = join(DOWNLOAD_DIR, `${stem}_${yyyymmdd}.xlsx`);
  await download.saveAs(outputPath);
  console.log(`下载完成: ${outputPath}（来源「${suggested}」）`);
  return outputPath;
}

/** 拉取段入口：返回落盘的 xlsx 绝对路径。interactive=false 时登录失效快速抛错（定时用）。 */
export async function fetchTzzb(
  opts: { interactive: boolean } = { interactive: true },
): Promise<string> {
  const browser = await connectOrHeal();
  try {
    const page = await getTzzbPage(browser);
    const button = await waitForExportButton(page, opts.interactive);

    let lastError: unknown;
    for (let attempt = 1; attempt <= EXPORT_RETRIES; attempt++) {
      try {
        const outputPath = await exportViaDownload(page, button);
        await saveAccountUrl(page.url()); // 记住成功导出的账户页，下次（含 headless）直达
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
    try {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close');
    } catch {
      // 优雅关失败 → 交给下面 killDebugChrome 兜底
    }
    await browser.close().catch(() => {}); // 断开 playwright CDP 连接（连接态下才能发上面的命令）
    killDebugChrome();
  }
}

/** 交互 = 有 TTY 且未显式 --headless（定时任务无 TTY 自动判为非交互）。 */
export function isInteractive(argv: string[]): boolean {
  return Boolean(process.stdin.isTTY) && !argv.includes('--headless');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
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
      process.exit(1);
    });
}
