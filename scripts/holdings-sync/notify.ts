/**
 * notify.ts — 结果上报：追加日志 + macOS 桌面通知（025 FR-012 L3 定时「跑完报结果」）。
 *
 * 定时（headless）跑无 TTY，stdout 进 launchd.log 用户不看；故成功/失败都：
 *   ① 追加 `~/.nvy/holdings-sync/sync.log`（带北京时间戳，可回溯历史）
 *   ② 弹 macOS 桌面通知（osascript），失败尤其要让用户第一时间知道需重新登录。
 *
 * 飞书推送不在此处：由外层通用 wrapper `ops/lib/nvy-run-reported.sh` 据退出码 + stdout 统一推
 * （webhook/签名集中一处，见 ops/runbook/scheduled-tasks.md）；sync.ts 把结果 console.log 出去即可。
 */

import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LOG_DIR = join(homedir(), '.nvy', 'holdings-sync');
const LOG_PATH = join(LOG_DIR, 'sync.log');
const TITLE = '持仓同步';

/** 北京时间戳（脚本可能在任意 TZ 跑，统一 +08:00 口径）。 */
function beijingStamp(): string {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date());
}

/** 追加一行到 sync.log（失败静默——日志写不了不该掩盖主流程结果）。 */
export async function logLine(message: string): Promise<void> {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    await appendFile(LOG_PATH, `[${beijingStamp()}] ${message}\n`);
  } catch {
    // 日志尽力而为
  }
}

/** 弹 macOS 桌面通知（仅 darwin；非 mac 静默跳过）。 */
export async function desktopNotify(message: string): Promise<void> {
  if (process.platform !== 'darwin') return;
  // 经参数传值避免 AppleScript 字符串注入（引号/换行）
  const script =
    'on run argv\n display notification (item 1 of argv) with title (item 2 of argv)\nend run';
  await new Promise<void>((resolve) => {
    const proc = spawn('osascript', ['-e', script, message, TITLE], { stdio: 'ignore' });
    proc.on('close', () => resolve());
    proc.on('error', () => resolve()); // osascript 缺失也不挂主流程
  });
}

/** 同时落日志 + 弹通知。 */
export async function report(message: string): Promise<void> {
  await logLine(message);
  await desktopNotify(message);
}
