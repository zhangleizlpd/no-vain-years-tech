#!/usr/bin/env tsx
/**
 * check-scheduled-tasks.ts — 定时任务上报机制守门（CI: pr-validation.yml 云端镜像）。
 *
 * 机器强制两条确定性 invariant（判断类的「该不该套 wrapper」留 .claude/rules 引导，不在此卡）：
 *   A. **飞书传输集中**：飞书 wire-format（payload key `msg_type` / bot webhook host
 *      `open.feishu.cn/open-apis/bot`）只许出现在 `ops/lib/feishu-send.sh`（+ 本守门脚本自身）。
 *      —— 防「每加一个调度就重写一遍 webhook/token/签名」（本次重构的核心诉求）。
 *   B. **注册表同步**：每个 systemd `*.timer` 单元名 + 本地 launchd `LABEL`（`com.*`）必须登记进
 *      `ops/runbook/scheduled-tasks.md`。—— 防注册表静默 stale。
 *
 * Full-scan（不依赖 nx affected）—— 机制是 holistic invariant。任一违反 → exit 1。
 * 扫描逻辑抽成纯函数 scanScheduledTasks（file-map 进、violations 出，无 fs）→ 可单测（.spec.ts）。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY_REL = 'ops/runbook/scheduled-tasks.md';
const SELF_REL = 'scripts/checks/check-scheduled-tasks.ts';
const SELF_SPEC_REL = 'scripts/checks/check-scheduled-tasks.spec.ts'; // spec 含 msg_type 测试夹具，亦白名单
const FEISHU_SEND_REL = 'ops/lib/feishu-send.sh';

const SCAN_DIRS = ['scripts', 'services', 'ops']; // host/OS 级定时任务域（apps/ 的 @Cron 应用内调度不在范围）
// 🚨 2026-08-07：这里少了几个 vendor 目录，代价是**整个 services/ 曾静默脱离扫描面**。
// 病灶链：walk 递归到 services/code-index/.hf-cache/…/model_quantized.onnx（bge-m3 权重，
// ~570MB）→ readFileSync(…, 'utf8') 抛 ERR_STRING_TOO_LONG（超 V8 字符串上限）→ 被下面
// SCAN_DIRS 循环的 `catch` 吞掉 → services/ 从第 2 个文件起**全部不扫**，闸照样打印 ✅。
// 实证：往 services/ 下任一脚本塞 `{"msg_type":"text"}`，守门依旧绿。
// ⇒ 三道防线，缺一都可能让它换个形状复活：① 显式跳 vendor 目录 ② 单文件大小上限
// ③ 下面的 catch 改成 fail-closed（只容忍「目录不存在」，其余重新抛）。
const SKIP_DIR = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.expo',
  'coverage',
  'venv', // services/futu-shim 的 Python venv（gitignored，7000+ 文件）
  '__pycache__',
  '.pytest_cache',
  '.hf-cache', // services/code-index 的 HuggingFace 模型权重（单文件数百 MB）
]);
// 被扫的都是脚本 / unit / 注册表这类文本；1MB 以上必然不是。兜底防「下一个大 blob」。
const MAX_FILE_BYTES = 1_000_000;

// 飞书 wire-format 标志串：选「飞书专属、正常代码不会撞」的两个（payload key + bot host）。
const FEISHU_MARKERS = [/\bmsg_type\b/, /open\.feishu\.cn\/open-apis\/bot/];
const CODE_EXT = /\.(sh|ts|mjs|cjs|js|service)$/;
const A_ALLOWLIST = new Set([FEISHU_SEND_REL, SELF_REL, SELF_SPEC_REL]);
// 匹配 bash `LABEL='com.x'` 与 TS `const LABEL = 'com.x'`。
const LABEL_RE = /\bLABEL\s*=\s*['"](com\.[\w.-]+)['"]/;

export interface SchedViolation {
  code: 'A' | 'B';
  file: string;
  reason: string;
}

const basename = (p: string): string => p.slice(p.lastIndexOf('/') + 1);

/**
 * 纯扫描（无 fs）：files = {相对仓根路径: 内容}，registry = 注册表 markdown 文本。
 * 返回违反两条 invariant 的清单。单测直接喂合成 file-map 驱动。
 */
export function scanScheduledTasks(
  files: Record<string, string>,
  registry: string,
): SchedViolation[] {
  const violations: SchedViolation[] = [];

  for (const [file, text] of Object.entries(files)) {
    // A: 飞书 wire-format 只许在 feishu-send.sh（+ 本脚本自身）
    if (CODE_EXT.test(file) && !A_ALLOWLIST.has(file)) {
      const hit = FEISHU_MARKERS.find((re) => re.test(text));
      if (hit) {
        violations.push({
          code: 'A',
          file,
          reason: `出现飞书 wire-format（${hit.source}）—— 飞书发送必须复用 ops/lib/feishu-send.sh 的 feishu_send，禁在调度脚本内重写 webhook/签名/curl。`,
        });
      }
    }

    // B-1: 每个 *.timer 单元名登记进注册表
    if (file.endsWith('.timer')) {
      const unit = basename(file);
      if (!registry.includes(unit)) {
        violations.push({
          code: 'B',
          file,
          reason: `systemd 单元 "${unit}" 未登记进 ${REGISTRY_REL}（新增/改定时任务须同 PR 登记）。`,
        });
      }
    }

    // B-2: 本地 launchd 生成器的 LABEL（com.*）登记进注册表
    if (/\/setup\.(sh|ts)$/.test(file)) {
      const m = text.match(LABEL_RE);
      if (m && !registry.includes(m[1])) {
        violations.push({
          code: 'B',
          file,
          reason: `launchd LABEL "${m[1]}" 未登记进 ${REGISTRY_REL}（本地定时任务也须登记）。`,
        });
      }
    }
  }

  return violations;
}

function main(): void {
  // cwd 无关：从脚本位置(scripts/checks/)反推仓根，免被调用方 cwd 漂移影响
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

  const files: Record<string, string> = {};
  const walk = (absDir: string): void => {
    for (const e of readdirSync(absDir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIR.has(e.name)) walk(join(absDir, e.name));
      } else {
        const abs = join(absDir, e.name);
        // 大文件直接跳：读它没意义，且 readFileSync(…,'utf8') 超上限会抛，
        // 抛出去就会把整棵子树的扫描一起带走（见 SKIP_DIR 上方注释）。
        if (statSync(abs).size > MAX_FILE_BYTES) continue;
        files[relative(root, abs)] = readFileSync(abs, 'utf8');
      }
    }
  };
  for (const d of SCAN_DIRS) {
    // 🚨 fail-closed：只容忍「这个域在本仓根本不存在」，其余异常一律抛出去炸红。
    // 原先是裸 `try/catch {}`，任何读文件的错都被当成「目录不存在」静默吞掉。
    const abs = join(root, d);
    if (!existsSync(abs)) continue;
    walk(abs);
  }

  const registry = readFileSync(join(root, REGISTRY_REL), 'utf8');
  const violations = scanScheduledTasks(files, registry);

  if (violations.length > 0) {
    console.error('❌ 定时任务上报机制守门失败：\n');
    for (const v of violations) console.error(`  - [${v.code}] ${v.file}: ${v.reason}`);
    console.error(
      '\n机制 SoT：ops/runbook/scheduled-tasks.md「新增定时任务时」+ .claude/rules/scheduled-tasks-registry.md。',
    );
    process.exit(1);
  }
  console.log(
    `✅ 定时任务机制守门通过（扫 ${Object.keys(files).length} 文件：飞书传输集中 + timer/LABEL 全登记）。`,
  );
}

// 仅作为脚本跑，不在被 .spec 导入时跑
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
