#!/usr/bin/env node
/**
 * setup.ts — L3 定时安装器（025 FR-012，仅 macOS）。
 *
 * 一条命令把「每天 09:00 自动拉取同花顺持仓 → 上传产线」装好（须早于 marketdata 09:05）：
 *   1. 平台/Chrome/Node 校验（非 macOS 直接拒）
 *   2. 交互首登 seed 凭证：跑一次 fetch（同花顺登录 + 选账户）+ upload（产线短信登录）
 *      —— 之后定时跑靠持久 Chrome profile + refresh token 轮转，无需再人工（除非登录态过期）
 *   3. 生成 wrapper `~/.nvy/holdings-sync/run-scheduled.sh`（固化 node/tsx 绝对路径——launchd
 *      PATH 极简）
 *   4. 写 LaunchAgent plist + `launchctl bootstrap gui/$UID`（GUI 域才能唤起 Chrome + 弹通知）
 *   5. 打印 `sudo pmset` 唤醒命令（launchd 内不便 sudo，引导用户手动跑一次）
 *
 * Usage:
 *   pnpm holdings:setup                                       # 默认产线 + 09:00
 *   pnpm holdings:setup --base-url http://127.0.0.1:3000 --time 09:00
 *   pnpm holdings:setup --skip-login                          # 已 seed 过，仅重装调度
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchTzzb } from './fetch-tzzb';
import { uploadHoldings } from './upload-holdings';

const LABEL = 'com.nvy.holdings-sync';
const PROD_BASE_URL = 'https://api.shintongtech.com';
const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const NVY_DIR = join(homedir(), '.nvy', 'holdings-sync');
// 飞书 wrapper / 发送原语的共享落点（与 marketdata 同用 ~/.nvy/lib，脱离 git checkout）
const LIB_DIR = join(homedir(), '.nvy', 'lib');
const SHARED_LIBS = ['feishu-send.sh', 'nvy-run-reported.sh'] as const;
const WRAPPER_PATH = join(NVY_DIR, 'run-scheduled.sh');
const LAUNCHD_LOG = join(NVY_DIR, 'launchd.log');
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

const TOOL_DIR = dirname(fileURLToPath(import.meta.url));

/**
 * 自包含运行时清单：拷进 ~/.nvy/holdings-sync 的源码 + 包声明（运行时图 sync→fetch-tzzb/notify/
 * upload-holdings→api，外加独立 install 用的 package.json/tsconfig）。
 */
const RUNTIME_FILES = [
  'api.ts',
  'fetch-tzzb.ts',
  'notify.ts',
  'sync.ts',
  'upload-holdings.ts',
  'package.json',
  'tsconfig.json',
] as const;

/**
 * 物化自包含运行时：把源码 + 包声明拷进 ~/.nvy/holdings-sync，并在其中装独立 node_modules
 * （playwright-core + tsx，约 23M；playwright-core 仅 connectOverCDP 系统 Chrome，免下 bundled 浏览器）。
 * 之后定时任务读这份**冻结副本**，不再 cd 任何 git worktree —— 根治「钉的 worktree 被删/切分支即停摆」
 * （见 06-22 holdings 停摆教训）。代价与 marketdata 副本范式一致：改源码须重跑 setup 覆盖。
 */
async function materializeRuntime(): Promise<void> {
  for (const f of RUNTIME_FILES) {
    await copyFile(join(TOOL_DIR, f), join(NVY_DIR, f));
  }
  console.log('安装自包含运行时依赖（playwright-core + tsx，首次约 20s）...');
  // --ignore-workspace：~/.nvy 在 mono 外，按独立工程装，不被父 workspace 干扰
  const res = spawnSync('pnpm', ['install', '--ignore-workspace', '--prod'], {
    cwd: NVY_DIR,
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    throw new Error(`~/.nvy/holdings-sync 依赖安装失败（pnpm install 退出码 ${res.status}）`);
  }
  if (!existsSync(join(NVY_DIR, 'node_modules', '.bin', 'tsx'))) {
    throw new Error('依赖装完但未见 node_modules/.bin/tsx —— install 可能未完整');
  }
}

/**
 * 拷飞书共享 lib 到 ~/.nvy/lib（feishu-send.sh + nvy-run-reported.sh），脱离 git worktree。
 * 生成的 wrapper 引用这份冻结副本；改 lib 须重跑 setup 覆盖（与 sync 运行时副本同范式）。
 */
async function materializeSharedLib(): Promise<void> {
  const repoLibDir = resolve(TOOL_DIR, '..', '..', 'ops', 'lib');
  await mkdir(LIB_DIR, { recursive: true });
  for (const f of SHARED_LIBS) {
    await copyFile(join(repoLibDir, f), join(LIB_DIR, f));
    await chmod(join(LIB_DIR, f), 0o755);
  }
}

function preflight(): void {
  if (process.platform !== 'darwin') {
    throw new Error('本工具的定时能力仅支持 macOS（launchd + pmset）。');
  }
  if (!existsSync(CHROME_PATH)) {
    throw new Error(`未找到 Google Chrome（${CHROME_PATH}）——请先安装。`);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 22) throw new Error(`需要 Node >= 22（当前 ${process.versions.node}）。`);
}

/** 交互 seed：拉取（同花顺登录 + 选账户）+ 上传（产线短信登录）落 refresh token。 */
async function seedCredentials(baseUrl: string): Promise<void> {
  console.log('\n=== 首登 seed（同花顺登录 + 产线短信登录，一次性）===');
  console.log('① 即将打开/复用调试 Chrome，请登录同花顺并切到目标账户「持仓列表」页。');
  const filePath = await fetchTzzb({ interactive: true });
  console.log('② 上传到产线（首跑需手机短信验证码）。');
  await uploadHoldings({ baseUrl, filePath, interactive: true });
  console.log('=== seed 完成，凭证已落 ~/.nvy/holdings-sync.json ===\n');
}

export function buildWrapper(baseUrl: string): string {
  const nodeDir = dirname(process.execPath);
  const reporter = join(LIB_DIR, 'nvy-run-reported.sh');
  // 跑 ~/.nvy 下的自包含副本（脱离 git checkout）；PATH 注入 node 目录供 tsx 的 env-node shebang 解析
  return [
    '#!/bin/zsh',
    '# 由 scripts/holdings-sync/setup.ts 生成——请勿手改，重跑 setup 覆盖',
    `export PATH="${nodeDir}:$PATH"`,
    // 飞书公共配置（webhook/secret/机器名）——可选；缺文件 → feishu-send.sh 静默跳过
    '[ -f "$HOME/.nvy/feishu-alert.env" ] && { set -a; . "$HOME/.nvy/feishu-alert.env"; set +a; }',
    `cd "${NVY_DIR}" || exit 1`,
    // 套通用 wrapper：跑完（成功/失败）都推飞书 report（机器+任务+持仓数）+ 写心跳供看门狗
    `exec /bin/bash "${reporter}" holdings-sync -- "./node_modules/.bin/tsx" sync.ts --headless --base-url "${baseUrl}"`,
    '',
  ].join('\n');
}

export function buildPlist(hour: number, minute: number): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>${WRAPPER_PATH}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${LAUNCHD_LOG}</string>
  <key>StandardErrorPath</key>
  <string>${LAUNCHD_LOG}</string>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>
`;
}

function installLaunchAgent(): void {
  const uid = process.getuid?.() ?? 0;
  const domain = `gui/${uid}`;
  // 幂等：先 bootout 旧实例（不存在则忽略），再 bootstrap
  spawnSync('launchctl', ['bootout', `${domain}/${LABEL}`], { stdio: 'ignore' });
  const res = spawnSync('launchctl', ['bootstrap', domain, PLIST_PATH], { encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`launchctl bootstrap 失败：${res.stderr || res.stdout || res.status}`);
  }
  // 校验已载
  execFileSync('launchctl', ['print', `${domain}/${LABEL}`], { stdio: 'ignore' });
}

export function parseTime(time: string): { hour: number; minute: number } {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!m) throw new Error(`--time 格式应为 HH:MM（收到 ${time}）`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`--time 越界：${time}`);
  return { hour, minute };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      'base-url': { type: 'string', default: PROD_BASE_URL },
      time: { type: 'string', default: '09:00' },
      'skip-login': { type: 'boolean', default: false },
    },
  });
  const baseUrl = values['base-url'].replace(/\/$/, '');
  const { hour, minute } = parseTime(values.time);

  preflight();
  await mkdir(NVY_DIR, { recursive: true });
  await mkdir(dirname(PLIST_PATH), { recursive: true });

  if (!values['skip-login']) {
    await seedCredentials(baseUrl);
  } else {
    console.log('跳过首登 seed（--skip-login）。');
  }

  await materializeRuntime();
  await materializeSharedLib();
  await writeFile(WRAPPER_PATH, buildWrapper(baseUrl), { mode: 0o755 });
  await chmod(WRAPPER_PATH, 0o755);
  await writeFile(PLIST_PATH, buildPlist(hour, minute));
  installLaunchAgent();

  console.log(`\n✅ 已安装定时任务 ${LABEL}：每天 ${values.time} → ${baseUrl}`);
  console.log(`   wrapper: ${WRAPPER_PATH}（跑 ~/.nvy 自包含副本，脱离 git worktree）`);
  console.log(`   plist:   ${PLIST_PATH}`);
  console.log(`   日志:    ${join(NVY_DIR, 'sync.log')}（结果）/ ${LAUNCHD_LOG}（原始输出）`);
  console.log('\n⚠️ Mac 在该时刻须醒着。若希望睡眠时自动唤醒，请用 sudo 跑一次（仅一次）：');
  const wakeHour = String(minute >= 2 ? hour : (hour + 23) % 24).padStart(2, '0');
  const wakeMin = String(minute >= 2 ? minute - 2 : 58).padStart(2, '0');
  console.log(`   sudo pmset repeat wakeorpoweron MTWRFSU ${wakeHour}:${wakeMin}:00`);
  console.log('\n手动触发一次验证：');
  console.log(`   launchctl kickstart -k gui/${process.getuid?.() ?? ''}/${LABEL}`);
  console.log('卸载：pnpm holdings:uninstall');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
