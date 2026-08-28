# quantwin-health — 代号 `quant-win` 实盘机健康探针

从**机外**监控实盘交易终端宿主的磁盘水位与交易进程存活，异常合并成**一条**飞书告警。

## 为什么需要它

2026-08-15 排查发现该机系统盘从 40 GB 满到只剩 **27.9 MB**：Windows 更新连续失败 5 次（`0x80070070 = ERROR_DISK_FULL`）、`CBS.log` 涨到 810 MB、servicing 陷入「盘满 → 清理失败 → 更满」的正反馈。**全程没有任何告警**，靠人工点进去才发现。

根因不是没清理机制，是**没有感知面**：

| 缺口       | 事实                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 云监控     | 机上**未装** CloudMonitor agent ⇒ 云侧采不到磁盘指标 ⇒ 配不出告警                                                                  |
| 机内自清理 | `StartComponentCleanup` 计划任务返回码 0 却没干活；`StorageSense` 直接坏（`0x80040154` 类未注册）；`Pre-staged app cleanup` 被禁用 |
| 进程存活   | 交易软件跑在**手工 RDP 交互式会话**里，无服务注册 / 无自动登录 / 无启动项 ⇒ 任何一次重启都会静默停摆                               |

本探针补的就是第一和第三条。**刻意不在实盘机上装任何东西** —— 少一个常驻进程就少一份风险。

## 怎么工作

```text
本机 launchd（每 30 min）
  └─ probe.sh
       ├─ aliyun ecs RunCommand ──> quant-win 执行一段 PowerShell
       │                              回读一行：free_mb / 进程存活 / 外部已建连 / uptime
       ├─ 判定（磁盘阈值 + 进程缺失）
       └─ 状态跃迁时 feishu_send 一条合并消息
```

该机**无 SSH**，云助手 `RunCommand` 是唯一通道（见 fleet 词汇表）。用的四个 ECS 权限（`RunCommand` / `DescribeInvocationResults` 等）现有 RAM 子账号**已具备**，无需加权。

## 告警行为

| 情况                               | 行为                                                   |
| ---------------------------------- | ------------------------------------------------------ |
| 磁盘 < `DISK_WARN_MB`（默认 4096） | 🟡 WARN                                                |
| 磁盘 < `DISK_CRIT_MB`（默认 2048） | 🔴 CRIT                                                |
| 任一受监控进程缺失                 | 🔴 CRIT                                                |
| 从异常恢复                         | ✅ 推一条恢复                                          |
| 健康                               | 每天首次跑过 `SUMMARY_HOUR`（默认 9 点）推一条 🟢 摘要 |
| 探测本身失败                       | **连续 2 次**才报（单次云 API 抖动不报）               |

**防刷屏**：只在**状态跃迁**时推；持续异常每 `REALERT_SEC`（默认 6h）复推一次。状态存 `~/.nvy/quantwin-health/state`。

**每日 🟢 摘要就是探针自身的 liveness 证据** —— 该来没来 = 探针死了。这是它不进 `nvy-watchdog` 清单的原因（高频监控套 wrapper 会每半小时刷屏，per `.claude/rules/scheduled-tasks-registry.md` §①.3）。

## 配置

| 文件                         | 内容                                                   |
| ---------------------------- | ------------------------------------------------------ |
| `~/.nvy/fleet.env`           | `NVY_QUANT_WIN_ECS_ID` — 实例 ID                       |
| `~/.nvy/quantwin-health.env` | 进程名、阈值等（模板见 `quantwin-health.env.example`） |
| `~/.nvy/feishu-alert.env`    | `NVY_ALERT_*` — 全机共享的飞书 webhook / 签名密钥      |

进程名**刻意不写死在仓内**：它们暴露「这台机跑哪家券商的哪个终端」，属业务侧可识别信息；且换终端 = 改一行 env，仓内零改动（同 `fleet.env` 的理由，per [information-boundary.md](../../docs/conventions/information-boundary.md)）。

## 用法

```bash
bash scripts/jobs/quantwin-health/setup.sh                 # 装（默认 30 min）
bash scripts/jobs/quantwin-health/setup.sh --interval 900  # 改成 15 min
bash scripts/jobs/quantwin-health/uninstall.sh             # 摘

launchctl kickstart -k gui/$(id -u)/com.nvy.quantwin-health   # 手动触发一次
tail -20 ~/.nvy/quantwin-health/launchd.log                    # 看结果
```

## ⚠️ 改了仓内 probe.sh 必须重跑 setup

launchd 跑的是 `~/.nvy/quantwin-health/probe.sh` 这个**冻结副本**（launchd 对 `~/Documents` 无 TCC，必须脱离 worktree）。不重跑 setup ⇒ 跑的仍是旧逻辑，且失败形态是**「静默的成功」**——`marketdata-dev-sync` 2026-08-11 踩过同一个坑。`deployed.meta` 记了部署时间与源 commit，可用于事后判断副本是否落后。

## 已知局限

- **`feishu_send` 吞掉所有发送失败**（设计如此：告警尽力而为，绝不改变调用方退出码）⇒ 「调用了」≠「送达了」。webhook 坏掉本身是静默的。
- **逃不出「本机宕机 / 睡死」** —— 本机探针挂了没人知道，唯有外部监控能兜。与 `nvy-watchdog` 同一局限。
- **只看磁盘与进程存活**，不看交易逻辑是否正常。进程活着但策略没跑，本探针看不出来。
