# futu-shim-guest-access（本体已私有化）

本文原含访客 token 签发流程、`app` ↔ `broker-hk` ↔ 访客三条 WireGuard 隧道的完整拓扑与公网 endpoint，以及一节「`AllowedIPs` 只约束地址不约束端口」的绕过分析。合起来是一份攻击手册，仓已公开 → 整篇移出。

- **本体**：`docs/private/runbook/futu-shim-guest-access.md` —— 仓内那条路径如今是 symlink，真身在仓外 `~/nvy-private/`（本机私有，未公开）
- **备份**：`~/nvy-private` 是本地 git 仓（误删 `git checkout` 即回），每日把 `git bundle` 经 age 加密推 prod 主机存异地副本
- **判据**：[`docs/conventions/information-boundary.md`](../../docs/conventions/information-boundary.md) §「私有散文」

## 公开侧还剩什么

代理的实现与部署机制全部在仓内 —— 限频值、路由白名单、守卫断言都可读可审（这些是设计的一部分，经得起公开）；出仓的只有隧道 endpoint 与 token 签发的操作细节。

| 公开物                                                                           | 作用                                                                 |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| [`services/guest-proxy/`](../../services/guest-proxy/)                           | nginx 模板 + `deploy/install.sh` + `verify-guards.sh` + systemd unit |
| [`services/guest-proxy/capabilities/`](../../services/guest-proxy/capabilities/) | 能力目录正文（`/capabilities` 下发的那份）                           |
| `.github/workflows/deploy-guest-proxy.yml`                                       | 合并即部署链                                                         |
| [`ops/host/fleet.env.example`](../host/fleet.env.example)                        | `NVY_GUEST_WG_ENDPOINT` 等变量契约                                   |

## 给访客加一个端点：改哪些地方

访客手里的 skill 自 2026-08-16 起是**薄壳**，不含端点清单 —— 清单由 `/capabilities`
在运行时下发。**因此加端点不再需要重新打包、也不需要联系访客**，只改仓内两处：

1. `nginx/futu-shim-guest.conf.template` —— 加 `location = /<新端点>`，连同它自己的市场闸 / 限频 zone
2. `capabilities/capabilities.md` —— 在「端点一览」表里加一行，并补它的参数说明与踩坑

**顺序无所谓，但两处必须同时到位**：`deploy/install.sh` 的预校验 ②(c)（Gate A）断言两侧
集合严格相等，漏一处部署当场红且**真容器一个字节都不会动**。

> 🚨 **不要**把新端点写进 `openclaw-skill/SKILL.md` 或 `guest-bundle/README.md`。
> 那会造出第二份会漂的拷贝，而漂移的形态是「访客手里那份还在按旧规矩跑」。
> `make-guest-bundle.sh` 的出包闸（Gate C）会拦。
>
> ℹ️ 想验访客侧真的看得到：`verify-guards.sh` 的闸 7 会拉一次目录，再对目录里的
> **每个**端点断言它不是 404。加端点后跑一次即可，不必手工核对。

**唯一还需要访客动手的情形**：skill 的 `description` 变了。它决定 skill 会不会被激活，
是本地的、不随目录下发 —— 改了就要重新出包让访客 `FORCE=1 ./setup.sh install-skill`。
⚠️ 改它之前先读 `make-guest-bundle.sh` 里 Gate D 那段注释（2026-08-16 PoC 实测：
description 写窄了，新能力不会触发 skill，而模型的**失败形态是照着记忆编数据**，不是说做不到）。
