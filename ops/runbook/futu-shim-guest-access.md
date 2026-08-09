# futu-shim-guest-access（本体已私有化）

本文原含访客 token 签发流程、`app` ↔ `broker-hk` ↔ 访客三条 WireGuard 隧道的完整拓扑与公网 endpoint，以及一节「`AllowedIPs` 只约束地址不约束端口」的绕过分析。合起来是一份攻击手册，仓已公开 → 整篇移出。

- **本体**：`docs/private/runbook/futu-shim-guest-access.md` —— 仓内那条路径如今是 symlink，真身在仓外 `~/nvy-private/`（本机私有，未公开）
- **备份**：`~/nvy-private` 是本地 git 仓（误删 `git checkout` 即回），每日把 `git bundle` 经 age 加密推 prod 主机存异地副本
- **判据**：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md) §「私有散文」

## 公开侧还剩什么

代理的实现与部署机制全部在仓内 —— 限频值、路由白名单、守卫断言都可读可审（这些是设计的一部分，经得起公开）；出仓的只有隧道 endpoint 与 token 签发的操作细节。

| 公开物                                                    | 作用                                                                 |
| --------------------------------------------------------- | -------------------------------------------------------------------- |
| [`services/guest-proxy/`](../../services/guest-proxy/)    | nginx 模板 + `deploy/install.sh` + `verify-guards.sh` + systemd unit |
| `.github/workflows/deploy-guest-proxy.yml`                | 合并即部署链                                                         |
| [`ops/host/fleet.env.example`](../host/fleet.env.example) | `NVY_GUEST_WG_ENDPOINT` 等变量契约                                   |
