---
paths:
  - '**/*.timer'
  - '**/*.service'
  - 'scripts/**/setup.sh'
  - 'scripts/**/setup.ts'
  - 'ops/jobs/**'
  - 'ops/lib/feishu-send.sh'
  - 'ops/lib/nvy-run-reported.sh'
  - 'ops/lib/nvy-watchdog.sh'
---

# 定时任务机制纪律（path-triggered，触及 `.timer` / `.service` / 本地生成器 / `ops/lib` 共享件时自动加载）

新增 / 改动 / 退役任何 **host/OS 级定时任务**（systemd `.timer`+`.service`，或本地 macOS launchd 生成器 `scripts/<name>/setup.*`）时，两件事都要做：**①接入飞书上报机制** + **②登记注册表**。canonical 步骤见 [`ops/runbook/scheduled-tasks.md`「新增定时任务时」](../../ops/runbook/scheduled-tasks.md#新增定时任务时checklist)；本 rule 只 surface 硬 invariant。

## ① 飞书上报机制（每加一个调度都走，**别重写 webhook/token**）

1. 脚本只「干活 + 打 stdout 汇总数字 + exit 0/非0」，**不自带飞书发送** —— webhook/签名/curl 集中在 `ops/lib/feishu-send.sh` 一处。
2. **每日批任务** → 入口套 `ops/lib/nvy-run-reported.sh <task> -- <cmd>`（成功 + 失败都推 report + 写心跳 `<心跳目录>/<task>.beat`。⚠️ **心跳目录本地与 prod 不同，别按本地路径去 prod 找**：本地 launchd 有 `$HOME` ⇒ `~/.nvy/heartbeats`；prod systemd **不注入 `$HOME`** ⇒ 经 `/etc/nvy-alert.env` 显式设 `NVY_HEARTBEAT_DIR=/var/lib/nvy/heartbeats`。解析规则全文见 runbook「心跳目录解析」）；并在本机看门狗清单加一行 —— 本地**改 `scripts/nvy-watchdog/setup.sh` 里的 `TASKS` 默认值**（⚠️ 别只靠调用时传 `--tasks`：默认值漏一项 = 任何人裸跑一次 setup 就静默摘掉该任务的 no-show 兜底且不报错，2026-07-30 futu-eod 踩过），77 改 `nvy-watchdog.service`。
3. **高频监控**（≤ 分钟级，如 tick/freshness）→ **不套** wrapper（会刷屏）；保留自身告警逻辑，飞书发送换 `. feishu-send.sh; feishu_send "$msg"`；正向 liveness 走每日摘要。
4. webhook/secret 复用本机共享文件（本地 `~/.nvy/feishu-alert.env`、prod `/etc/nvy-alert.env`，同一套 `NVY_ALERT_*`）；systemd 单元加 `EnvironmentFile=-/etc/nvy-alert.env`。**不新建** webhook/token。bot 用「签名校验」（`NVY_ALERT_FEISHU_SECRET`），不依赖关键词。

## ② 登记注册表

归到对应 host section，一行含：任务 | 调度 | 触发器 unit/label | 执行 | 仓库锚点 | 用途。退役则删行 + 在相关 runbook 注明，别留 stale 行。漏登记 = 注册表静默 stale，后人查「哪台机器在跑什么定时任务」时被误导。

> 文件形态（同名三件套 / 文件名 = unit / `.sql` 必须同目录同名兄弟 / 安装走 `install.sh`；`ops/lib` 共享件例外）per [`docs/conventions/repo-layout.md` § ops/jobs 的内部形态](../../docs/conventions/repo-layout.md) —— CI 只抓 ExecStart 目标，`.sql` 错位抓不到，写的时候自查。

## CI 硬门（绕不过）

`scripts/checks/check-scheduled-tasks.ts`（挂 `pr-validation.yml`）机器卡两条确定性 invariant：**A** 飞书 wire-format（`msg_type` / `open.feishu` bot host）只许在 `ops/lib/feishu-send.sh`；**B** 每个 `.timer` 单元 + 本地 launchd `LABEL` 登记进注册表。判断类（每日任务该不该套 wrapper / 加看门狗）本 rule 引导，CI 不卡。

## 不在范围（不登记 — 别误加进注册表）

- server 内部 `@nestjs/schedule @Cron`（`apps/server/`）—— 应用进程内调度，归 server 代码。
- OS 自带 systemd timer（apt / logrotate / sysstat / fstrim / certbot 发行版默认 …）—— 系统维护，非业务。

## 触发盲区（rule path-trigger 够不到，靠人记）

本地 launchd `.plist` 装在 `~/Library/LaunchAgents/`、cron 在 crontab —— 均在仓库外，本 rule 触发不到。新增这类任务时**手动**更新注册表（其仓库生成器 `scripts/<name>/setup.*` 能触发本 rule + CI 校验 LABEL，是主要兜底）。
