#!/usr/bin/env node
/**
 * upload-holdings.ts — 持仓导出文件上传段（025 T019, FR-012）。
 *
 * 凭证链（003 tokens，refresh 单次轮转语义）：
 *   1. 读 `~/.nvy/holdings-sync.json`（按 base-url 分槽存 refresh token，chmod 600）
 *   2. 调 refresh 端点换 access + 新 refresh —— **新 refresh 先回写再继续**（旧的已被
 *      原子撤销，写失败即丢凭证，所以回写优先于上传）
 *   3. 无 token / refresh 401 → **交互模式**走 CLI 短信登录；**headless（定时）模式直接抛错**
 *      （定时任务无 TTY，不能 prompt；登录失效让用户收通知后手动重登）
 *
 * 上传走原生 `fetch` multipart（api.ts，无 @nvy/api-client 依赖——自包含可移植）。
 * asOf 取文件名中的 YYYYMMDD；返回导入摘要供 sync 上报。
 *
 * Usage（自包含目录内 `pnpm run upload`，或根 `pnpm holdings:upload`）:
 *   pnpm holdings:upload                          # 取下载目录最新一份 → dev
 *   pnpm holdings:upload --base-url https://api.shintongtech.com
 *   pnpm holdings:upload --file <path.xlsx>       # 指定文件（跳过拉取）
 *   pnpm holdings:upload --headless               # 非交互（定时）：失效即抛错不 prompt
 */

import { chmod, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  ApiError,
  importHoldings,
  phoneSmsAuth,
  requestSmsCode,
  rotateRefreshToken,
  type ImportSectionSummary,
  type ImportSummary,
} from './api';

const TOKEN_STORE_PATH = join(homedir(), '.nvy', 'holdings-sync.json');
const DOWNLOAD_DIR = join(homedir(), '.nvy', 'holdings-sync');
const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

export interface UploadOptions {
  baseUrl: string;
  filePath?: string;
  /** 交互模式允许 CLI prompt（短信登录）；headless（定时）下失效即抛错。 */
  interactive: boolean;
}

/** token 存储：按 base-url 分槽（dev / prod 凭证互不串）。 */
type TokenStore = Record<string, { refreshToken: string }>;

async function readTokenStore(): Promise<TokenStore> {
  try {
    return JSON.parse(await readFile(TOKEN_STORE_PATH, 'utf8')) as TokenStore;
  } catch {
    return {};
  }
}

async function writeTokenStore(store: TokenStore): Promise<void> {
  await mkdir(join(homedir(), '.nvy'), { recursive: true });
  await writeFile(TOKEN_STORE_PATH, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  await chmod(TOKEN_STORE_PATH, 0o600); // mode 仅在创建时生效，既有文件补一刀
}

/** CLI 交互短信登录（首跑 / refresh 失效兜底）→ 返回 access，refresh 已落盘。 */
async function smsLogin(baseUrl: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let phone = '';
    while (!/^\+861[3-9]\d{9}$/.test(phone)) {
      const raw = (await rl.question('手机号（11 位，自动补 +86）> ')).trim();
      phone = /^1[3-9]\d{9}$/.test(raw) ? `+86${raw}` : raw;
      if (!/^\+861[3-9]\d{9}$/.test(phone)) console.log('格式不对，重输。');
    }
    const sent = await requestSmsCode(baseUrl, phone);
    console.log(`验证码已发送（${sent.ttlSec}s 内有效）`);

    let code = '';
    while (!/^\d{6}$/.test(code)) {
      code = (await rl.question('短信验证码（6 位）> ')).trim();
    }
    const auth = await phoneSmsAuth(baseUrl, phone, code);
    const store = await readTokenStore();
    store[baseUrl] = { refreshToken: auth.refreshToken };
    await writeTokenStore(store);
    console.log(`登录成功（accountId=${auth.accountId}），refresh token 已存 ${TOKEN_STORE_PATH}`);
    return auth.accessToken;
  } finally {
    rl.close();
  }
}

/** 凭证入口：refresh 轮转优先（新 refresh 先回写）；失效 → 交互短信登录 / headless 抛错。 */
async function obtainAccessToken(baseUrl: string, interactive: boolean): Promise<string> {
  const store = await readTokenStore();
  const saved = store[baseUrl]?.refreshToken;
  if (saved) {
    try {
      const rotated = await rotateRefreshToken(baseUrl, saved);
      store[baseUrl] = { refreshToken: rotated.refreshToken };
      await writeTokenStore(store); // 旧 refresh 已原子撤销，先持久化新的再继续
      console.log('refresh token 已轮转续期');
      return rotated.accessToken;
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        if (!interactive) {
          throw new Error('refresh token 已失效（401），请手动重新登录：pnpm holdings:upload');
        }
        console.log('refresh token 已失效（401），转短信登录');
      } else {
        throw err; // 网络/5xx 不烧凭证，直接报错
      }
    }
  } else if (!interactive) {
    throw new Error(
      `无本地 token（${baseUrl}），请先手动登录：pnpm holdings:setup 或 pnpm holdings:upload`,
    );
  } else {
    console.log(`无本地 token（${baseUrl}），首跑短信登录`);
  }
  return smsLogin(baseUrl);
}

/** 无 --file 时取下载目录最新一份（文件名 `<账户名>_YYYYMMDD.xlsx`，按日期降序取最新）。 */
async function pickLatestFile(): Promise<string> {
  const dated = (await readdir(DOWNLOAD_DIR).catch(() => [] as string[]))
    .map((name) => ({ name, date: /_(\d{8})\.xlsx$/.exec(name)?.[1] }))
    .filter((e): e is { name: string; date: string } => e.date !== undefined)
    .sort((a, b) => a.date.localeCompare(b.date));
  const latest = dated.at(-1)?.name;
  if (!latest) {
    throw new Error(
      `下载目录无导出文件（${DOWNLOAD_DIR}/<账户名>_YYYYMMDD.xlsx）——先跑 fetch-tzzb.ts 或用 --file 指定`,
    );
  }
  return join(DOWNLOAD_DIR, latest);
}

function asOfFromFileName(filePath: string): string {
  const m = /(\d{8})/.exec(basename(filePath));
  if (!m) throw new Error(`文件名缺 YYYYMMDD 日期，无法定 asOf: ${basename(filePath)}`);
  return `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`;
}

function printSection(label: string, s: ImportSectionSummary): void {
  console.log(
    `  ${label}: ${s.imported} 入库 / ${s.skipped.length} 跳过 / ${s.warnings.length} 警示`,
  );
  for (const item of s.skipped) console.log(`    ⏭ 行 ${item.row}: ${item.reason}`);
  for (const w of s.warnings) console.log(`    ⚠ ${w}`);
}

/** 上传段入口：解析 asOf → 凭证 → multipart 导入 → 摘要表；返回摘要供上报。 */
export async function uploadHoldings(opts: UploadOptions): Promise<ImportSummary> {
  const filePath = opts.filePath ?? (await pickLatestFile());
  const asOf = asOfFromFileName(filePath);
  console.log(`上传 ${filePath}（asOf=${asOf}）→ ${opts.baseUrl}`);

  const accessToken = await obtainAccessToken(opts.baseUrl, opts.interactive);
  const buf = await readFile(filePath);
  const summary = await importHoldings(
    opts.baseUrl,
    accessToken,
    { bytes: new Uint8Array(buf), filename: basename(filePath) },
    asOf,
  );

  console.log(`✅ 导入完成（asOf=${summary.asOf}）`);
  printSection('持仓  ', summary.holdings);
  printSection('已清仓', summary.closed);
  printSection('交易  ', summary.trades);
  return summary;
}

export function parseCliArgs(argv: string[]): UploadOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      'base-url': { type: 'string', default: DEFAULT_BASE_URL },
      file: { type: 'string' },
      headless: { type: 'boolean', default: false },
    },
  });
  // 交互 = 有 TTY 且未显式 --headless（定时任务无 TTY 自动判为非交互）
  const interactive = Boolean(process.stdin.isTTY) && !values.headless;
  return {
    baseUrl: values['base-url'].replace(/\/$/, ''),
    filePath: values.file ? resolve(values.file) : undefined,
    interactive,
  };
}

/** 错误 → 可读输出（ApiError 带 status + problem detail）。 */
export function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  uploadHoldings(parseCliArgs(process.argv.slice(2))).catch((err) => {
    console.error(describeError(err));
    process.exit(1);
  });
}
