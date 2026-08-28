#!/usr/bin/env node
/**
 * sync.ts — 持仓同步一键入口（025 T019/L3, FR-012）：fetch → upload 串联。
 *
 * 两种运行姿态（同一入口，靠 TTY / --headless 自动判定）：
 *   - 交互（手动跑）：登录失效时 prompt 引导；结果打到 console。
 *   - headless（launchd 定时）：登录失效快速抛错不挂死；**跑完落日志 + 弹桌面通知报结果**。
 *
 * Usage:
 *   pnpm holdings:sync                                   # 拉取 + 上传 dev（交互）
 *   pnpm holdings:sync --base-url https://api.shintongtech.com
 *   pnpm holdings:sync --headless --base-url <prod>      # 定时（launchd wrapper 用）
 */

import { fetchTzzb, isInteractive } from './fetch-tzzb';
import { report } from './notify';
import { describeError, parseCliArgs, uploadHoldings } from './upload-holdings';

async function main(): Promise<void> {
  const opts = parseCliArgs(process.argv.slice(2));
  const filePath = await fetchTzzb({ interactive: opts.interactive });
  const summary = await uploadHoldings({ ...opts, filePath });

  // L3：定时（headless）跑完用户不看 console，落日志 + 弹通知报结果
  if (!opts.interactive) {
    const { holdings, closed, trades } = summary;
    const line = `同步成功（${summary.asOf}）→ ${opts.baseUrl}：持仓 ${holdings.imported} / 已清仓 ${closed.imported} / 交易 ${trades.imported}`;
    console.log(line); // 打到 stdout 供外层 nvy-run-reported wrapper 抓进飞书 report
    await report(line); // 落 sync.log + 桌面通知
  }
}

main()
  .then(() => process.exit(0)) // CDP 连接挂着 event loop，显式退出
  .catch(async (err) => {
    const msg = describeError(err);
    console.error(msg); // 进 stderr → wrapper 据非零退出码推飞书告警（含此文案）
    // headless 失败必须让用户知道（多半是登录过期需手动重登）
    if (!isInteractive(process.argv.slice(2))) {
      await report(`同步失败：${msg}`); // 飞书推送由外层 wrapper 负责，这里只落本地 log + 桌面通知
    }
    process.exit(1);
  });
