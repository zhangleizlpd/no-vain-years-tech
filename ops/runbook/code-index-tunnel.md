# Runbook — code-index 62↔77 WireGuard 隧道接线（接地 S3 部署前置）

> **前置**：本文命令块里的 `$NVY_*` 从仓外解析 —— 本机跑先 `. ~/.nvy/fleet.env`，主机上跑先 `. /etc/nvy-fleet.env`。变量清单与角色说明见 [`ops/host/fleet.env.example`](../host/fleet.env.example)；为什么真值不入库见 [`information-boundary.md`](../../docs/conventions/information-boundary.md)。
>
> ✅ **已上线（2026-06-25 live 实证）**：62（`mbw-indexer`）`wg0` 隧道活跃（peer=77 `mbw-staging`，handshake 持续 + 双向流量）；77 app `CODE_INDEX_PROVIDER=http` / `CODE_INDEX_URL=http://10.88.0.1:7700`；77→隧道 `/healthz` 返 `{"ok":true}` 端到端通。本文档以下为**首次 bring-up 手册 + 运维 SoT**（rollback / token 轮换 / 排障仍用）；安全组与 bring-up 步骤为历史执行记录，勿当「待办」误读。
>
> 🔴 **77 上不止这一条隧道**（2026-07-31 起）：本文的 `wg0` = `10.88.0.0/24`（62↔77）；另有 **`wg1` = `10.89.0.0/24`（B↔C，77↔港机 `mbw-futu-hk`）**，见 [`futu-opend-hk.md` §二](./futu-opend-hk.md)。**动 77 的 WireGuard 配置前先确认改的是哪一条** —— 接口名与网段刻意错开，别混。
>
> **目的**：把 77 上的 mono ideation server 经**加密隧道**接到 62 上的 code-index `/search` + `/repos`，兑现 034 接地检索的真检索（[spec](../../specs/034-ideation-grounding-retrieval/spec.md) / [plan §7](../../specs/034-ideation-grounding-retrieval/plan.md)）。关闭 [`code-index-deploy.md` §待办 phase E](./code-index-deploy.md) 的网络暴露 TODO。
>
> **决策**（S2 plan §E / 2026-06-23 确认）：**WireGuard 点对点隧道**（跨账号两机最稳，无证书/域名负担）。service token 明文严禁裸公网——隧道加密承载。备选自签 TLS 反代已弃（管证书 + 安全组放公网 IP，更重）。

## 拓扑

> 主机定位（账号 / IP / 规格 / 角色）以 [`host-inventory.md`](./host-inventory.md) 为准；下表为 62↔77 **隧道专属**接线（WireGuard 虚 IP / 隧道角色）。

|                 | 62（账号 A，code-index 宿主）              | 77（账号 B，mono 全栈宿主）                           |
| --------------- | ------------------------------------------ | ----------------------------------------------------- |
| 公网 IP         | `$NVY_INDEX_HOST`（仓外解析）              | `$NVY_APP_HOST`（仓外解析）                           |
| SSH             | `mbw-indexer`                              | `mbw-staging`                                         |
| WireGuard 虚 IP | `10.88.0.1/24`                             | `10.88.0.2/24`                                        |
| 角色            | 隧道「服务端」（被连），code-index `:7700` | 隧道「客户端」（主动连 + keepalive），ideation server |

- code-index 查询 API 现绑 `0.0.0.0:7700`（`services/code-index/src/server.ts:72`），公网由安全组拦死、**保持拦**；77 只经隧道虚 IP `10.88.0.1:7700` 访问，**无需改 code-index 监听**。
- 隧道握手走公网 **UDP 51820**；业务流量（`/search`/`/repos`）走隧道内 `10.88.0.1:7700`，全程加密。
- `CODE_INDEX_SERVICE_TOKEN` 两端**同值**：62 的 `/etc/code-index.env` 已有真 token（服务 fail-closed 已在跑）→ **读出来复制到 77**，**不重新生成**（勿轮换在跑的 token）。

```text
┌───────────── 公网 ─────────────┐
app                              index
 ideation server (docker)         code-index query API (systemd :7700)
 wg0 10.88.0.2  ──UDP 51820──►   wg0 10.88.0.1
        └── http://10.88.0.1:7700/search （隧道内，Bearer token）──┘
```

## 前置：安全组（你在两账号控制台改，我做不了）

阿里云安全组由控制台管（per `reference_aliyun_swas_ufw_incompat`，OS 层 ufw 不兼容）。两条入方向规则：

1. **62（账号 A 控制台）**：入方向放行 **UDP 51820**，源 = `$NVY_APP_HOST/32`（仅 `app`）。**不要**放行 TCP 7700 公网（保持拦）。
2. **77（账号 B 控制台）**：入方向放行 **UDP 51820**，源 = `$NVY_INDEX_HOST/32`（仅 `index`）。

> verify：两条规则均「仅对端公网 /32」，非 `0.0.0.0/0`。改完告诉我，我再驱动两机 bring-up。

## A. WireGuard bring-up（62 + 77，我经 SSH 驱动，你逐步确认）

> 两机各跑一次；密钥在各自机器本地生成，**私钥永不离机、永不入库**。

### A.1 装 + 生成密钥（各机）

```bash
# 62 与 77 各执行
apt-get update && apt-get install -y wireguard
umask 077
wg genkey | tee /etc/wireguard/wg0.key | wg pubkey | tee /etc/wireguard/wg0.pub
cat /etc/wireguard/wg0.pub   # 打印本机公钥（交换给对端，公钥可明文传）
```

### A.2 写 wg0.conf（各机，填对端公钥）

**62** `/etc/wireguard/wg0.conf`（`PrivateKey` 取本机 `wg0.key`，`PublicKey` 填 **77 的公钥**）：

```ini
[Interface]
Address = 10.88.0.1/24
ListenPort = 51820
PrivateKey = <62 的 /etc/wireguard/wg0.key 内容>

[Peer]
# 77
PublicKey = <77 的公钥>
AllowedIPs = 10.88.0.2/32
```

**77** `/etc/wireguard/wg0.conf`（`PublicKey` 填 **62 的公钥**，`Endpoint` 指 62 公网；77 主动连 + keepalive 穿 NAT/conntrack）：

```ini
[Interface]
Address = 10.88.0.2/24
PrivateKey = <77 的 /etc/wireguard/wg0.key 内容>

[Peer]
# 62
PublicKey = <62 的公钥>
Endpoint = <$NVY_INDEX_HOST>:51820
AllowedIPs = 10.88.0.1/32
PersistentKeepalive = 25
```

### A.3 起隧道 + 开机自启（各机）

```bash
systemctl enable --now wg-quick@wg0
wg show           # verify：peer 有 latest handshake（几秒内）+ transfer 增长
```

verify（端到端隧道通）：

```bash
# 在 77 执行
ping -c 3 10.88.0.1                      # 通
curl -fsS http://10.88.0.1:7700/healthz  # {"ok":true}（无 token 的 healthz）
```

## B. token 复制（62 → 77，明文 scp/手抄，两机 git 树外）

```bash
# 1) 读 62 现有 token（已签发、服务在用，勿改）
ssh mbw-indexer 'set -a; . /etc/code-index.env; set +a; echo "$CODE_INDEX_SERVICE_TOKEN"'
# 2) 把该值写进 77 的 /home/admin/.env.production（见 C），与 62 严格一致
```

> 若 62 竟无 token（不应发生，服务 fail-closed 会拒启）→ 按 [`code-index-deploy.md` §B](./code-index-deploy.md) 生成 `openssl rand -hex 32` 后**两端同步**并重启 `code-index-query.service`。

## C. 77 env 接线 + 重部署

> 🚨 **两个激活前置（缺一则隧道通但 app 接地仍是 fake，2026-06-23 实证）**：
>
> 1. **镜像须含接地代码**：grounding 集成（#557）必须在 77 运行的镜像里。`server-v0.11.0`(2026-06-22) **预** dates #557 → 该镜像无 codeindex，填 env 全 inert。**先确认 `server-vX.Y.Z ≥ 含 #557 的 release`**（`git merge-base --is-ancestor <#557-sha> <tag>`）。
> 2. **77 的 `docker-compose.tight.yml` 须含 `CODE_INDEX_*` environment 映射**（#557 加，`:155-157`）。deploy.yml 默认 `skip_git_fetch=true` → 77 compose 停在旧 commit、**无映射** → 容器拿不到 CODE_INDEX env → app config 静默默认 `fake`（同 `MARKETDATA_PROVIDER` 静默吞陷阱）。**激活接地的 deploy 必须 `skip_git_fetch=false`** 拉新 compose。
>
> ⇒ **推荐路径**：直接走 `deploy.yml`（`workflow_dispatch`，tag=含 #557 的 release，**`skip_git_fetch=false`**）一把到位——它同时拉新 compose（映射）+ pull 新镜像（代码）+ 保留 `.env.production`（下面的 CODE_INDEX 值）。下面手动步骤仅用于隧道/排障期单独验证。

在 77 `/home/admin/no-vain-years-mono/.env.production` 填（`.env.production` 为 git 树外，deploy `git reset --hard` 不动它；`.env.production.example:134-136` 同款）：

```ini
CODE_INDEX_PROVIDER=http
CODE_INDEX_URL=http://10.88.0.1:7700
CODE_INDEX_SERVICE_TOKEN=<B 步从 62 读到的同值>
```

手动重部署（仅当不走 deploy.yml）。🚨 **必须 `sops exec-env` 包裹**——77 已 post-SOPS-cutover，真 DB 密码等 secret 在 `secrets.enc.env`（age key `~/.config/sops/age/keys.txt`），`.env.production` 里的 DB_PASSWORD 是占位值；**裸 `--env-file` recreate 会用占位密码 → `P1000 Authentication failed` → app 崩溃 loop**（2026-06-23 实证打崩 ~3min）：

```bash
# 77
cd /home/admin/no-vain-years-mono
# ✅ 正确（sops 注入真 secret，compose ${VAR} 插值优先读 shell env 赢 --env-file）
sops exec-env secrets.enc.env "docker compose -f docker-compose.tight.yml --env-file .env.production up -d --force-recreate app"
# ❌ 禁：docker compose ... --env-file .env.production up -d --force-recreate app（裸跑 → 占位 DB 密码 → P1000）

# verify（ps/logs 只读, 不必 sops 包裹; "DB_PASSWORD not set" warning 无害）：
docker compose -f docker-compose.tight.yml --env-file .env.production ps app          # Up (healthy)
docker compose -f docker-compose.tight.yml --env-file .env.production logs --tail=30 app | grep -iE 'Nest|P1000|Zod'   # Nest started, 无 P1000/Zod
docker exec nvy-tight-app-1 printenv CODE_INDEX_PROVIDER                               # ⚠️ 必须打印 http（空=compose 无映射, 见上前置 2, app 在 fake）
```

## D. 端到端 smoke（接地真打）

```bash
# D.1 隧道内直打 code-index（在 77 宿主）
set -a; . /home/admin/.env.production; set +a
curl -fsS -H "Authorization: Bearer $CODE_INDEX_SERVICE_TOKEN" \
  http://10.88.0.1:7700/repos | head -c 400            # verify：200 {repos:[{repo:"mono",...}]}
curl -fsS -H "Authorization: Bearer $CODE_INDEX_SERVICE_TOKEN" \
  -X POST http://10.88.0.1:7700/search \
  -d '{"repo":"mono","query":"登录 use case"}' | head -c 400   # verify：命中 results

# D.2 env-gated 真后端 IT（本地，打真隧道；默认 skip，per 034 T007）
#     需本机能经隧道/跳板到 10.88.0.1:7700，或在 77 宿主跑
RUN_CODEINDEX_IT=1 CODE_INDEX_URL=http://10.88.0.1:7700 \
  CODE_INDEX_SERVICE_TOKEN=$CODE_INDEX_SERVICE_TOKEN \
  nx test server ideation-grounding   # verify：真 /search+/repos 命中 + 命名空间隔离 绿

# D.3 真 app 接地一轮（最终 dogfood，SC-005）
#     在 mobile 选 mono → 提问需查代码的需求 → 见来源折叠引用真实文件
```

verify（降级反例，确认 FR-008 真生效）：临时 `systemctl stop wg-quick@wg0`（62 或 77）→ 接地一轮应**降级系统气泡 + 会话不中断**，不报错卡死 → 恢复 `systemctl start wg-quick@wg0`。

## Rollback / teardown

- **回退接地**（保留隧道）：77 `.env.production` 注释三行 / 设 `CODE_INDEX_PROVIDER=fake` → `up -d --force-recreate app`。ideation 退回 fake provider（catalog 空、检索返空 + 降级气泡），会话仍可用。
- **拆隧道**：两机 `systemctl disable --now wg-quick@wg0` + 删 `/etc/wireguard/wg0.*` + 撤两条安全组 UDP 51820 规则。
- **token 轮换**（泄露时）：生成新 `openssl rand -hex 32` → 同步 62 `/etc/code-index.env`（重启 `code-index-query.service`）+ 77 `.env.production`（`up -d --force-recreate app`），两端必须同步切换（fail-closed，过渡期会 401）。

## 已知坑

- **漏映射静默吞**：compose 漏 `CODE_INDEX_*` 映射 → 容器读不到 → `http` 被静默吞成 `fake`（同 `MARKETDATA_PROVIDER` 陷阱）。本仓 `docker-compose.tight.yml:155-157` 已映射，勿删。
- **token 不入日志**：`Authorization: Bearer` 注入，code-index `auth.ts` 用 `timingSafeEqual` 常量时间比对，永不打 token、不下发客户端。
- **隧道挂 ≠ 业务挂**：隧道断 → code-index 端口不可达（throw）→ ideation UC catch → 降级 `notice` 气泡 + 视作空命中续问（FR-008 / ADR-0060），**会话不中断**。这是设计韧性，非 bug。
- **62 不跑冷建**（ADR-0060 ≤1 模型）：隧道只承载查询，索引构建仍在 62 本机 cron，与隧道无关。
