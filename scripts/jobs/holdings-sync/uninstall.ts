#!/usr/bin/env node
/**
 * uninstall.ts — 卸载 L3 定时任务（025 FR-012，仅 macOS）。
 *
 * `launchctl bootout` 卸载 LaunchAgent + 删 plist + wrapper；打印 pmset cancel 引导。
 * 不删 ~/.nvy/holdings-sync.json（refresh token）与下载文件——保留以便重装免重登。
 *
 * Usage: pnpm holdings:uninstall
 */

import { spawnSync } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const LABEL = 'com.nvy.holdings-sync';
const PLIST_PATH = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const NVY_DIR = join(homedir(), '.nvy', 'holdings-sync');
const WRAPPER_PATH = join(NVY_DIR, 'run-scheduled.sh');
// 自包含副本产物（与 setup.ts materializeRuntime 对称）：卸载时清掉，保留凭证/日志/下载/账户态
const RUNTIME_ARTIFACTS = [
  'node_modules',
  'pnpm-lock.yaml',
  'api.ts',
  'fetch-tzzb.ts',
  'notify.ts',
  'sync.ts',
  'upload-holdings.ts',
  'package.json',
  'tsconfig.json',
];

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('定时能力仅 macOS；无可卸载项。');
  }
  const uid = process.getuid?.() ?? 0;
  // bootout（不存在则忽略），再删 plist + wrapper + 自包含副本产物
  spawnSync('launchctl', ['bootout', `gui/${uid}/${LABEL}`], { stdio: 'ignore' });
  await rm(PLIST_PATH, { force: true });
  await rm(WRAPPER_PATH, { force: true });
  for (const f of RUNTIME_ARTIFACTS) {
    await rm(join(NVY_DIR, f), { recursive: true, force: true });
  }

  console.log(`✅ 已卸载定时任务 ${LABEL}（plist + wrapper + 自包含运行时副本已删）。`);
  console.log('   refresh token（~/.nvy/holdings-sync.json）与下载文件保留——重装免重登。');
  console.log('\n如之前设过 pmset 唤醒，按需取消（sudo）：');
  console.log('   sudo pmset repeat cancel');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
