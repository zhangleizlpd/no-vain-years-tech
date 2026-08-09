# futu-opend-hk（本体已私有化）

本文是 `broker-hk` 主机（券商网关：Futu OpenD + futu-shim）的运维手册。整篇移出，触发点是其中一行把 **operator 的家庭/办公出口 IP 作为 SSH `/32` 白名单条目**写在了安全组步骤里 —— 那是对自然人的物理位置信息，不属于基础设施标识符，也没法在保住安全组流程可用的前提下脱敏掉。

- **本体**：`docs/private/runbook/futu-opend-hk.md` —— 仓内那条路径如今是 symlink，真身在仓外 `~/nvy-private/`（本机私有，未公开）
- **备份**：`~/nvy-private` 是本地 git 仓（误删 `git checkout` 即回），每日把 `git bundle` 经 age 加密推 prod 主机存异地副本
- **判据**：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md) §「私有散文」

## 公开侧还剩什么

服务的**代码与部署机制**全部在仓内，可读可审；只有「这台机器在哪、谁能连、从哪连」出仓。

| 公开物                                                            | 作用                                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- |
| [`services/futu-shim/`](../../services/futu-shim/)                | shim 全部源码 + `deploy/`（install / remote-deploy / systemd unit）+ pytest |
| `.github/workflows/deploy-futu-shim.yml`                          | tar-over-SSH 部署链（主机地址走 repo secrets）                              |
| `ops/jobs/futu-shim-health.sh` + 同名 systemd `.service`/`.timer` | 健康探测与告警                                                              |
| [`ops/host/fleet.env.example`](../host/fleet.env.example)         | `broker-hk` 的代号与变量契约                                                |

隧道内的 RFC1918 地址（`10.89.x`）刻意保持公开 —— 私有段地址在没有 WireGuard 公钥**且**没有公网 endpoint 时是惰性的，而 endpoint 正是移出的那部分。
