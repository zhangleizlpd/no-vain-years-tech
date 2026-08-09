# 接地检索增量 17h 停摆 —— 根因取证与三层修复（62 / code-index）

> 2026-08-03 事故记录。飞书告警：`接地检索增量停滞: origin/main@220f03b4 已 300m 未进检索（last_sha=5fa18946, 窗口 30m）`。
> 运维 SoT = [`ops/runbook/code-index-deploy.md`](../../../ops/runbook/code-index-deploy.md)（本记录的耐久结论已回写该 runbook「宿主 runtime 坑」节）。

## 1. 现象

`code-index-tick.service` 于 08-03 01:20:47 起跑，01:22:09 打印 `✓ incremental done: +22 chunks · stored 8125 · vectors 8125`（**活已干完、`last_sha` 已落库**），随后 **16h59m 不退出**：`activating (start)`、`ep_poll` 休眠、CPU 恒定在 1min21s（零增长）、RSS 1.05G。期间 `origin/main` 前进 4 个 commit，一个都没进检索。

## 2. 证据链

| 观察点                                   | 读数                                                              | 推论                                                             |
| ---------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------- |
| `systemctl status code-index-tick`       | `activating (start) since 01:20:47; 16h ago`，Main PID 存活       | 进程干完活不退出，unit 无法收尾                                  |
| `systemctl status code-index-tick.timer` | `active (running)`，但 **`Trigger: n/a`**；`list-timers` NEXT `-` | timer「活着」却永不再触发 → 监控只查 `is-active` 会误判健康      |
| `ps -o time,wchan`                       | CPU 16h 不涨、`ep_poll`                                           | 不是死循环 / 不是慢，是等一个永远不来的事件                      |
| `ss -tanp` / `lsof`                      | 该进程**零 TCP 连接**，仍持有 `model_quantized.onnx` fd           | `pool.end()` 已完成 → app 层无 pending，卡在 runtime 层          |
| `/proc/<pid>/task/*/comm`                | 4 组 `iou-sqp-*` / `iou-wrk-*` 线程                               | libuv 走了 io_uring 路径                                         |
| `/proc/<pid>/fdinfo/<uring fd>`          | Sq/Cq head==tail、`CQEs: 0`、无 `CqOverflowList`                  | 环已排空却仍在等 → 完成事件**丢了**，libuv 的 request 计数不归零 |
| `node -p process.versions.uv`            | **1.48.0**（node 自身 v18.19.1）                                  | Ubuntu 包的 node 链的是**系统 libuv**，非 node 18 自带的 1.44    |
| `uname -r`                               | 6.8.0-63-generic                                                  | 命中 Ubuntu 24.04 + kernel 6.8 + libuv ≥1.45 的已知踩雷组合      |

## 3. 根因分解（两层，别混为一谈）

1. **停摆 17h 的原因（已证实，直接观测）**：`Type=oneshot` 的 systemd 默认 `TimeoutStartSec=infinity`，一次挂死把 unit 永久钉在 `activating`；而 `OnUnitActiveSec=2min` 的 timer **要等本次激活结束才排下一次 elapse** → `Trigger: n/a`，此后一次不跑。**单点挂死被放大成永久停摆，这一层是自己的设计缺口，不是上游 bug。**
2. **进程挂死的原因（强旁证，未直接证伪对照）**：libuv 1.48 在 kernel 6.8 上的 io_uring 路径丢 fs 完成事件，pending request 不归零 → loop 不空 → 进程不退。上游对该组合的规避即 `UV_USE_IO_URING=0`（[nodejs/node#51875](https://github.com/nodejs/node/issues/51875) 起的回归链；node 后续版本默认关掉 io_uring，见 [686da19](https://github.com/nodejs/node/commit/686da19abb)；Ubuntu 侧 [LP#2105471](https://bugs.launchpad.net/ubuntu/+source/linux/+bug/2105471) 同形态）。

## 4. 没有证实的部分（诚实标注）

**没做 A/B 复现**。journal 自 06-23 服务上线起完整保留：`remote moved` 223 次、`incremental done` 222 次 —— **这是 222 次嵌入运行里的第 1 次挂死（基率 ~0.45%）**。要在对照组里期望撞上 1 次需 ~200 次运行（该机 ~0.3 chunk/s，5h+ 机时），重复跑不构成可行的验证路线。故第 3 节第 2 层的判定停留在「症状与已知缺陷全对 + 规避零副作用」，不是「实验证实」。第 3 节第 1 层则是直接观测，无歧义。

## 5. 修复（三层）

| 层                   | 改动                                                                                                               | 作用                                                                    |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 消除疑似根因         | tick + query 两个 unit 加 `Environment=UV_USE_IO_URING=0`                                                          | 关掉 io_uring 路径（纯 CPU 索引本就无收益），libuv 回落 threadpool 走法 |
| 兜底自愈（模式无关） | tick unit 加 `TimeoutStartSec=90min`                                                                               | **任何**挂死（含未知模式）超时 → SIGTERM → unit failed → timer 立即重排 |
| 让告警说出病因       | `check-index-freshness.sh` 加 §5：tick unit 卡 `activating` 超 `INDEX_TICK_STUCK_MIN`（默认 45min）→ 并入 problems | 告警不再只报「落后 300m + timer ✅」，直接点名 builder 挂死             |

`TimeoutStartSec` 取 90min 的理由：正常批次 22 chunk ≈ 75s，最坏可想象批次（数百 chunk）也在 30min 内；取值过紧会在超大批次上砍掉未 `setMeta` 的运行、下一 tick 从同一 diff 重来 → 死循环，比停摆更难看。

query unit 那一条是**预防性**（该进程 5 周无异常）：它 fork bge-m3 sidecar，sidecar 若挂死会一直持有 query heartbeat，使每次 tick 自我跳过 —— 同一个停摆，从 query 侧进入。

## 6. 验证

- **恢复**：停掉挂死 unit（`systemctl stop code-index-tick.service`）后 timer **立即**重排，2s 内起跑下一次 tick → 反过来印证第 3 节第 1 层的因果（timer 不是坏了，是被前一次激活堵着）。
- **追平**：`5fa18946..220f03b4`，10 文件 / 131 chunk，18:25:48 → 18:32:42 跑完（`✓ +131 chunks · stored 8130 · vectors 8130`），18:32:44 干净退出；`index_meta.last_sha` = `220f03b4`，timer NEXT 恢复 2min 节奏。
- **新 unit 生效读数**：`systemctl show` 得 `TimeoutStartUSec=1h 30min`、两个 unit 均 `Environment=UV_USE_IO_URING=0`；query 重启后 `/healthz` `{"ok":true}`，`/proc/<pid>/environ` 实见该变量。
- **监控 §5 两条分支**（`systemd-run --no-block --service-type=oneshot sleep` 造真·卡在 `activating` 的探针 unit，sed 换名后跑，避免污染真链路）：`INDEX_TICK_STUCK_MIN=0` → `tick: ❌ 卡在 activating` + exit 1；默认阈值 → `tick: ⏳ 正在跑` + exit 0；健康态原样跑新脚本 → `✅ 接地检索增量正常` + exit 0。
  - 坑：`systemd-run` 对 `--service-type=oneshot` **默认阻塞等 job 结束**，漏 `--no-block` 时探针根本没建起来，测试会打在「健康态」上空转成假绿 —— 第一轮就这么骗过一次。

## 7. 复发怎么认（30 秒诊断）

告警说落后、`code-index-tick.timer` 却显示 active 时，**别停在 timer 上**：

```bash
systemctl status code-index-tick.service          # 卡在 activating? → builder 挂死
systemctl list-timers code-index-tick.timer       # NEXT 是 "-" → timer 永不再触发
systemctl stop code-index-tick.service            # 活已干完的话，停掉即恢复（timer 立刻重排）
```
