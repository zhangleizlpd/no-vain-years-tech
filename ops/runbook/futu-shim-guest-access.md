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
在运行时下发。**因此加端点不再需要重新打包、也不需要联系访客**，只改仓内这几处：

1. `nginx/futu-shim-guest.conf.template` —— 加 `location = /<新端点>`，连同它自己的市场闸 / 限频 zone
   - **若它打的是本机 mono（不是港机 shim）**，还有两件 shim 类端点不需要的事：① `proxy_set_header`
     **整组三条**必须抄进 location（那是整组覆盖不是逐条合并，漏抄会把 shim 那把 token 漏下去，
     表现成「这个访客 token 不对」而真因是代理少了一行）；② 响应上 KB 就要在 location 里显式开
     `gzip` + `gzip_types application/json`（nginx 两项默认都不给 JSON 压缩，而漏了**两侧都不报错**，
     访客只会觉得慢）
2. `capabilities/capabilities.md` —— 在「端点一览」表里加一行，并补它的参数说明与踩坑
3. **仅当**该端点此前在 `verify-guards.sh` 闸 2 的「不可见」名单里（`/his-vol` `/universe`
   `/trading-days` `/earnings-calendar` 这几条）—— 把它从那个 `for p in …` 列表里**移出去**，
   并按 `/overview` 2026-08-07 那次的先例，给它单独写一条正例或参数闸断言

**1 与 2 必须同时到位**：`deploy/install.sh` 的预校验 ②(c)（Gate A）断言两侧集合严格相等，
漏一处部署当场红且**真容器一个字节都不会动**。

**3 漏了不会让部署红，但会让 `verify-guards.sh` 红** —— 那是刻意的：闸 2 那份名单是
「上游有、但**决定不给**访客」的清单，把其中一条改成开放是一个需要被看见的决策，不该
静默发生。2026-08-16 本机 e2e 实撞过这个形态。

> 🚨 **不要**把新端点写进 `openclaw-skill/SKILL.md` 或 `guest-bundle/README.md`。
> 那会造出第二份会漂的拷贝，而漂移的形态是「访客手里那份还在按旧规矩跑」。
> `make-guest-bundle.sh` 的出包闸（Gate C）会拦。
>
> ℹ️ 想验访客侧真的看得到：`verify-guards.sh` 的闸 7 会拉一次目录，再对目录里的
> **每个**端点断言它不是 404。加端点后跑一次即可，不必手工核对。

## 给访客**放宽一个已有端点的市场闸**：与「加端点」不是同一件事

行情面那五条 location（`/kline` + 期权四条）各自写着一份市场白名单正则。**把某个市场加进去
不是「加端点」的一个变种，它有一个专属的坑**：

🚨 **Gate A 看不见它。** `deploy/install.sh` 的 Gate A 断言「目录列的端点集 ≡ nginx 的 location
集」—— 放宽正则既不加 location、也不加目录行 ⇒ **nginx 开了一个市场而能力目录仍写着没开，
部署照样全绿**。而那个漂移的后果恰好是 `/capabilities` 当初要消灭的那一个：访客侧模型照旧
目录回「做不到」，且它的失败形态是**照记忆编数据**，不是老实说不知道。

所以这一形态要改**四处**：

1. `nginx/futu-shim-guest.conf.template` —— 五条正则**逐条**改（单数 `code` 三条、复数 `codes`
   两条形态不同），连同各自的 `detail` 文案
   - 🚫 **别动复数版那一步字符集白名单**（`[^A-Za-z0-9.,\-]`）：它挡的是 `%2C` 百分号编码绕过，
     与放行哪些市场正交。放宽它，两步闸整体失效
2. `capabilities/capabilities.md` —— 改口径散文，**并改那行机读声明** `<!-- quote-markets: … -->`
3. `verify-guards.sh` —— 闸 3 里所有拿该市场当反例的断言**换靶**到一个仍被拒的市场，**不是删**
   （只删的话闸 3 就没有负控制了）；`%2C` 绕过那条尤其要换，否则「绕过成功」与「被拒」都是
   400、它会恒绿
4. **注释里的举例**同步换靶 —— 拿一个已经合法的市场举例，等于在解释一件不再成立的事

**闸 10 是这一形态的机器守门**：它读目录那行机读声明，对一个固定候选市场集逐个发探针，
按响应体文案区分「nginx 拒的」还是「shim 拒的」（两者都是 400），**两个方向都断言** ——
声明了的必须真放行、没声明的必须真被拒。只验一个方向的闸，另一半是恒真的。

改完在开发机跑 `verify-guards.local-harness.sh`：基线必须全绿，`MUTATE=3`（nginx 收回、目录
不动）与 `MUTATE=4`（目录收回、nginx 不动）必须各让闸 10 真红。

**唯一还需要访客动手的情形**：skill 的 `description` 变了。它决定 skill 会不会被激活，
是本地的、不随目录下发 —— 改了就要重新出包让访客 `FORCE=1 ./setup.sh install-skill`。
⚠️ 改它之前先读 `make-guest-bundle.sh` 里 Gate D 那段注释（2026-08-16 PoC 实测：
description 写窄了，新能力不会触发 skill，而模型的**失败形态是照着记忆编数据**，不是说做不到）。
