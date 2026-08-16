# 部署拓扑与跨服务上线顺序

> **本文只拥有「没有任何单服务 runbook 能拥有」的那部分** —— 全景、密钥依赖图、跨服务改动的排序决策。
> 各单元自己的部署步骤 / 回滚 / 排障**留在各自 runbook**，本文只链过去，**不复述**（复述必 drift）。
>
> 主机一律以代号出现，真值从仓外解析（见 [`host-inventory.md`](host-inventory.md)）。

## 1. 部署单元全景

| 单元            | 宿主                                           | 部署链                   | 触发                                                                                              | **人工闸**                                                                                                   | 细节                                                              |
| --------------- | ---------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| **mono app**    | `app`                                          | `deploy.yml`             | `workflow_run`（跟在 `Build & Push Image` 之后）+ `workflow_dispatch`。**没有 push / paths 触发** | **两道** ① Release PR 由维护者手动合 ② `Deploy` job 声明 `environment: production`，卡该环境的 reviewer 审批 | [prod-deploy-rollback.md](prod-deploy-rollback.md)                |
| **guest-proxy** | `app`（**与 app 同机**，`network_mode: host`） | `deploy-guest-proxy.yml` | `push: main` + `paths: services/guest-proxy/**`                                                   | **无** —— 合入即部署                                                                                         | [prod-deploy-rollback.md § 第二条部署链](prod-deploy-rollback.md) |
| **futu-shim**   | `broker-hk`                                    | `deploy-futu-shim.yml`   | `push: main` + `paths: services/futu-shim/**`                                                     | **无**                                                                                                       | 两跳：runner → `app` → 港机（走 wg1 隧道内 SSH）                  |
| **mobile web**  | Cloudflare Pages                               | `deploy-web.yml`         | `push: tags mobile-v*.*.*` + `workflow_dispatch`                                                  | 发版 tag 由 release-please 的 Release PR 驱动（维护者手合）                                                  | [mobile-eas-release.md](mobile-eas-release.md)                    |
| **code-index**  | `index`                                        | **无 workflow**          | —                                                                                                 | **全手工**                                                                                                   | [code-index-deploy.md](code-index-deploy.md)                      |

### 🚨 「谁先上」由**人工闸的数量**决定，不是由触发方式

同一个 PR 同时改了 app 与 guest-proxy 时，**guest-proxy 必然先上** —— 但真因不是「push+paths 触发更快」，而是 **app 侧要多过两道人工闸**。

这个区别不是文字游戏：按「触发方式」归因会得出「改一下触发就能调顺序」的错误结论；按「人工闸」归因才能看出**顺序的下界由你点鼠标的时机决定**，任何自动化都改不了。2026-08-15 057 上线时按前一种归因排的序，窗口照样出现了。

## 2. SOPS 密钥的消费者：**直接读**与**派生**是两回事

密文 canonical 在 dev 机，prod 常驻 `/etc/nvy/secrets.enc.env`（增改与推送见 [secrets-sops.md](secrets-sops.md)）。但**它不是只有一类消费者**：

| 类型       | 谁                                                                                                 | 新键什么时候生效                          |
| ---------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| **直接读** | `deploy.yml` / `ops/bin/rollback-prod.sh`（`sops exec-env` 注入 app 容器）                         | 密文到宿主 + 下次部署 → **自动生效**      |
| **派生**   | guest-proxy：`/etc/nvy-guest-proxy.env` 由 `services/guest-proxy/render-env.sh` 从密文**渲染**出来 | ⚠️ **不自动** —— 必须在宿主上重跑一次渲染 |

**加新密钥时必须问这一句**：它有没有派生消费者？漏问的表现是 guest-proxy 部署红在 `nginx -t`（`[emerg] unknown "..." variable`），而 app 那侧一切正常 —— 两个消费者的失败时机完全错开，很容易只看到一半。

判据不要写成「当前有几个」（会 drift），按需扫：

```bash
rg -l 'secrets.enc.env' ops/ services/
```

## 3. 跨服务改动：排序决策

一次改动同时碰了多个单元时，**别背场景，按下面四问推**：

1. **有没有新增 SOPS 密钥？** → 先带外推密钥到宿主（[secrets-sops.md](secrets-sops.md) §3.3），再问第 2 问。
2. **有没有派生消费者需要重渲染？** → 有则在宿主上先渲染（§2 那张表）。⚠️ 首次引入新键时这一步有**先有鸡还是先有蛋**，见 [prod-deploy-rollback.md § 首次给 guest-proxy 引入新 env 键](prod-deploy-rollback.md)。
3. **被依赖方先上。** 谁 `proxy_pass` / HTTP 调谁，谁就是依赖方 —— 依赖方后上，中间那段时间它打过去是 502。当前唯一这种关系是 **guest-proxy → app（loopback 端口）**。
4. **人工闸多的那条要留出时间。** app 侧两道闸意味着它**不会**自己上线；若第 3 问要求它先上，就必须先把两道闸点完，再让通道侧那条链跑。

> **验收永远验运行态，不看 workflow 的 conclusion**（部署 `success` 与「新镜像真的在跑」是两件事，本仓已因此踩过）：
>
> ```bash
> . ~/.nvy/fleet.env
> ssh "$NVY_APP_SSH" 'sudo docker ps --format "{{.Names}}\t{{.Image}}"'
> ```

## 4. 一条反复发作的方法论

**预演环境与真环境「形状」不一致时，绿是没有意义的。** 本仓已两次栽在同一形态上：

- 本机用 bridge 网络 + 端口映射预演，真环境是 `network_mode: host` ⇒ 容器内的 `:80` 本机谁也不碍着，线上撞 prod nginx 当场起不来。
- 本机跑 `nginx -t` 时手上有那个 env 变量，宿主上没有 ⇒ envsubst 不替换，同一份模板本机绿、线上 `[emerg]`。

⇒ 判据不是「我测了吗」，是「**我测的那个东西，形状和真环境一样吗**」：网络模式、env 集合、文件系统布局、跑的身份，都是形状的一部分。拿不准就去真宿主上跑一次等价命令 —— 多数预校验（如 `install.sh` 那段一次性容器 `nginx -t`）本来就是可以在宿主上单独复现的。
