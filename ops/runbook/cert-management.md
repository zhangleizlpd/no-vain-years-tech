# cert-management（本体已私有化）

本文原含 **RAM 用户 → 权限集 → 宿主机上凭据文件的确切路径** 逐条映射（`/root/.ossutilconfig`、`/root/.aliyun/config.json` 等）。那是一份提权购物清单，仓已公开 → 整篇移出。

- **本体**：`docs/private/runbook/cert-management.md` —— 仓内那条路径如今是 symlink，真身在仓外 `~/nvy-private/`（本机私有，未公开）
- **备份**：`~/nvy-private` 是本地 git 仓（误删 `git checkout` 即回），每日把 `git bundle` 经 age 加密推 prod 主机存异地副本
- **判据**：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md) §「私有散文」

移出的重建成本可接受：证书续期本身是**自动**的，本文只是 break-glass 手册。

## 公开侧的自动化仍完整

| 公开物                                                               | 作用                                             |
| -------------------------------------------------------------------- | ------------------------------------------------ |
| [`ops/host/cert/hooks/`](../host/cert/hooks/)                        | certbot deploy hook + 阿里云 DNS-01 auth/cleanup |
| `ops/jobs/cert-expiry-monitor.sh` + 同名 systemd `.service`/`.timer` | 到期监控与告警                                   |

即：续期与告警的**机制**在仓内可读可审；只有「哪个 RAM 用户拿哪份凭据、文件落在哪」出仓。
