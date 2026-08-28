---
adr_id: ADR-0026
status: Accepted
applies_to: [apps/server, infrastructure]
sunset_trigger: |
  - M3+ 真实用户压力 → 升 RDS PG + 云 Redis
  - Plan 3 重新 scope（推 P2P / 仅本地 / SaaS 全外包）让部署形态判废
  - SWAS 单实例资源饱和（GC frequency / P95 拉长 / 内存接顶）→ 升 ECS 4c8g 或 A-Split 拓扑
---

# ADR-0026: Backend Deployment Topology — 单机紧凑拓扑 (A-Tight v2) + 既有资源复用

- Status: Accepted (2026-05-23)
- Deciders: project owner
- Tags: backend / deployment / infrastructure / cross-cutting

> **Note (2026-06-22，迁账号 B / 77 staging + 决策 A)**：staging/线上测试载体已从 **62**（账号 A SWAS 2c4g）迁到 **77**（账号 B ECS 2c2g），驱动 = 资源向账号 B 收敛 + 合规（`api.shintongtech.com` 备案接入即在 77）。**A-Tight v2 单机紧凑形态不变**（app + PG + Redis + Nginx 同机 docker compose），故按 [ADR-0031](0031-adr-governance.md) §「`Accepted` 非决策变更豁免」**in-place 记此 Note**，下方 2026-05-23 决策表保留作历史。当前态对以下决策点具体值的更新：
>
> - **D1 Compute**：账号 A SWAS → **账号 B ECS（77，2c2g）**；真 prod 仍另起独立 ECS（本次仅 staging/预发）。
> - **D5 镜像 registry（决策 A）**：ACR **维持账号 A**（账号 B 企业实名认证建不了免费个人版 ACR，企业版付费对预发载体不值当）→ 77 **公网跨账号拉**账号 A 的 ACR（registry 凭证级、不碰 RAM，实测近内网速）；ACR 迁 B 推迟到真 prod。此为 ADR-0026 原本没有的**跨账号依赖**，属 staging 权宜，核心拓扑结论不变。
> - **D7 备案 / 域名**：`api.xiaocaishen.me`（从未备案、已废弃）→ **`api.shintongtech.com`**（企业域名，备案在账号 B）。
> - **D4 Secrets 注入**：`--env-file` 裸注 → **SOPS（`sops exec-env` + age 私钥）**（已由 SOPS adoption 取代；`.env.production` 仅剩非密配置）。
> - **数据保护 / 周边**：备份 `pg_dump → mbw-oss` → **`oss://mbw-pg-backup`（账号 B 私有桶，profile `mbw-oss-b`）**；证书续期（api → nginx 卷；img → OSS put-cname）+ cert 监控亦迁 77。
>
> 全流程 + 踩坑见 `docs/private/runbook/prod-migrate-62a-to-77b.md`（本机私有，未公开 —— 整篇是跨账号拓扑，per [`information-boundary.md`](../conventions/information-boundary.md)；真身在仓外 `~/nvy-private/`，每日 age 密文 bundle 推 prod 主机存异地副本）。

## Context

[Plan 2/3](../private/plans/2026-05/05-25-account-migration-master.md) Phase 1（后端首次部署）决定 `apps/server`（NestJS + Fastify + Prisma）的物理部署形态。

本 ADR 锁定部署 = **单机紧凑拓扑（代号 A-Tight v2）**：app + PG + Redis + Nginx 全部 docker compose 跑在同一台 SWAS，不引入托管 DB / Redis / 对象存储；并**复用既有生产资源**（同一台 SWAS + 同 ACR 仓 + 同域名 + 同 OSS bucket + 同 Resend），原则「复用既有资源」最小化新基础设施 provisioning。

历史 baseline：

- 后端 `apps/server` 只在本地 Docker Compose 跑过 W1.4 PoC（per `docker-compose.dev.yml`）
- 一台 SWAS（cn-shanghai）已以同形态运行既有生产服务
- 域名 `api.xiaocaishen.me` 已国内备案、在用
- 阿里云 ACR 个人版 `${NVY_ACR_REPO}`（namespace/repo = `mbw_xcs/mbw-app`；registry 主机含实例 ID，故走 secret / fleet.env，per [`information-boundary.md`](../conventions/information-boundary.md)）在用

## Decision

### 7 决策点（2026-05-23 锁定）

| #   | 决策点         | 锁定值                                                                | 联动 ADR / Memory                                                                                                                                                                                                       |
| --- | -------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Compute 形态   | **SWAS 单实例**（复用既有同一台）                                     | SWAS 与 OS 层 ufw 不兼容，安全组只走阿里云控制台（见下表 SWAS bootstrap 行）                                                                                                                                            |
| D2  | DB 托管        | **SWAS 同机 docker compose `postgres:16-alpine`**                     | drop + recreate（`prisma migrate deploy` + seed），不保留既有 Java Flyway schema                                                                                                                                        |
| D3  | Redis 托管     | **SWAS 同机 docker compose `redis:7-alpine`**                         | drop + `FLUSHALL`，不保留既有 keys                                                                                                                                                                                      |
| D4  | Secrets 注入   | **`--env-file .env.production`（docker compose CLI flag）**           | deploy.yml 用 `docker compose --env-file .env.production`；文件权限 + .gitignore 双保险；[ADR-0037](0037-security-credentials-governance.md) § secrets 的 `secrets:` 段 + `/run/secrets` 是未来硬化（Proposed，未实装） |
| D5  | 镜像 registry  | **阿里云 ACR 个人版 `mbw_xcs/mbw-app`**（namespace + repo 名 全复用） | drop-in image replacement；push 同 repo，`server-vX.Y.Z` tag（per [ADR-0042](0042-monorepo-release-strategy.md) component-in-tag）+ `latest` 覆盖既有 latest                                                            |
| D6  | CI/CD pipeline | **GitHub Actions → SSH deploy**（复用既有 workflow 体例 + secrets）   | secrets 复用：`APP_SSH_KEY` / `APP_HOST` / `APP_SSH_USER` / `ACR_USERNAME` / `ACR_PASSWORD`                                                                                                                             |
| D7  | 备案 / 域名    | **复用 `api.xiaocaishen.me`**（已国内备案，接管不需重新备案）         | 解 CF → 未备案国内 ECS 525 跨境问题（见 [ADR-0025](0025-frontend-cloudflare-pages-expo-web.md)）                                                                                                                        |

### A-Tight v2 拓扑细则

| 项             | 决策                                                                                                                                               |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 数据盘         | **不挂** — PG/Redis 数据落 SWAS 系统盘；保护机制 = `pg_dump → mbw-oss` daily 备份（24h loss window M1.1 内测前可接受）                             |
| 对象存储       | **直接接 `mbw-oss` bucket + RAM 子用户 `mbw-server`**（复用既有已 provisioned）— 不启用 MinIO                                                      |
| Email 通道     | **Resend HTTPS API**（复用既有 `RESEND_API_KEY` + `sender@xiaocaishen.me` DKIM/SPF）；mono M1.1 阶段不主动发 email，但 SDK + secrets 配置就位      |
| HTTPS / 反代   | **Nginx 反代 + Let's Encrypt SSL** — 复用既有 nginx 配 + 证书 + reverse-proxy path                                                                 |
| SWAS bootstrap | **跳 ufw 整段**（2026-05 实证，本行即 SoT）— SWAS 简化网络模型与 ufw default deny 冲突 → 管理面失联                                                |
| 内存预算       | **Node ~500MB-1GB（相较此前 JVM 1.5g）** — 2c4g SWAS 余量更宽（Node + PG + Redis + Nginx ≈ 1.8GB，低于此前 JVM 部署 2.86GB），不需调 `-Xmx` 类参数 |

### 部署切换（cutover）流程

> **权威 compose**：仓根 `docker-compose.tight.yml` 是 prod 唯一权威（deploy.yml 实际 `docker compose -f docker-compose.tight.yml --env-file .env.production` 用它）；`docker-compose.dev.yml` 是本地 PoC。

1. build-image push `mbw_xcs/mbw-app:server-v0.0.1` 到 ACR（per Sub-PR 3.3）
2. SWAS 上停既有 server container：

   ```bash
   docker compose -f docker-compose.tight.yml --env-file .env.production stop app
   ```

3. 改 SWAS 上 `.env.production`：`MBW_VERSION=server-v0.0.1`
4. Drop + recreate PG / Redis 数据（M1.1 内测前无真用户数据）：

   ```bash
   docker exec mbw-tight-postgres-1 dropdb -U mbw mbw
   docker exec mbw-tight-postgres-1 createdb -U mbw mbw
   docker exec mbw-tight-redis-1 redis-cli FLUSHALL
   ```

5. 切到 mono compose project 并起 app（per Sub-PR 3.4 deploy.yml + docker-compose.tight.yml 新建）：

   ```bash
   docker compose -f docker-compose.tight.yml --env-file .env.production down  # 停既有 compose
   # 切 mono compose 文件 (project name nvy-tight)
   docker compose -f /home/admin/no-vain-years-mono/docker-compose.tight.yml --env-file .env.production pull app
   docker compose -f /home/admin/no-vain-years-mono/docker-compose.tight.yml --env-file .env.production up -d --force-recreate
   ```

6. mono server 启动后跑 `prisma migrate deploy`（首次启动 hook）+ seed 数据
7. healthcheck `nvy-tight-app-1` healthy + smoke `curl https://api.xiaocaishen.me/healthz/live` 200 → 既有 server 退场完成

## Consequences

### Positive

- **零新基础设施 provisioning** — SWAS / 备案 / 域名 / ACR / OSS / Resend / SSH key / SSL 证书 全复用既有已 provisioned，省 7-14 天备案 lag + 多项 setup 成本
- **零 cross-cutting service migration 风险** — 不动 PG/Redis/MinIO/OSS 体例（drop+recreate 是 mono prisma schema 自管，不靠 schema cross-stack 反推实验）
- **rollback path 明确** — 既有 image 在 ACR 保留历史 tag（`mbw_xcs/mbw-app:v0.X.Y`），如 mono 故障可改 `.env.production MBW_VERSION` 回历史 tag + 起对应 compose
- **Node 内存余量 > JVM 时代** — 2c4g SWAS 不需 `-Xmx` 调参，GC pause / P95 表现预期更稳

### Negative / Trade-offs

- **同一 SWAS 跑双 compose 临时占内存** — cutover 期间需先停 meta compose 才起 mono，无 zero-downtime（M1.1 阶段无 SLO 约束可接受）
- **`mbw_xcs/mbw-app:latest` tag 覆盖既有历史 latest** — 既有服务退役后 latest 永远指 mono；如临时回滚需用 immutable version tag (`v0.X.Y`)
- **同 SWAS 单点故障** — ECS 故障即全停服；可容忍 M1 阶段（升级路径见 sunset_trigger）
- **PG/Redis 数据 drop+recreate** — 每次 cutover 都全丢 dev/staging 数据；M2+ 100 内测起触发 RDS PG 评估

### 中性

- **mono compose project `nvy-tight` 与既有 `mbw-tight` 命名分离** — 同 SWAS 理论可并跑（不同 compose project + 不同 container 名），但端口（5432/6379/3000）会撞，实操不并跑

## Alternatives Considered

- **新 SWAS 实例 + 新 namespace + 新域名** — 拒绝：备案 7-14 天 lag + 额外月费 + 跨域名 DNS 迁移 + Resend sender domain 重新 DKIM/SPF 验证，user 明示「复用原来的资源」原则
- **ECS + 自管 docker（meta 现 ufw 双层）** — 拒绝：SWAS 月费更低 + 单层云边界防火墙已够 M1 solo dev 阶段
- **RDS PG + 云 Redis 从 M1 起** — 拒绝：成本翻倍且无法本地化开发
- **K8s / Serverless** — 拒绝：over-engineered for solo dev M1-M2；NestJS + Prisma + Redis 长连接 vs Serverless cold start 不亲

## Open Questions

无（全 7 决策 + A-Tight v2 6 继承项已显式锁定）。

## References

- [Plan 2/3](../private/plans/2026-05/05-25-account-migration-master.md) Phase 1
- [ADR-0018](0018-backend-language-pivot.md)（backend pivot to TS/NestJS）
- [ADR-0037](0037-security-credentials-governance.md)（secrets 注入路径 D4）
- [ADR-0042](0042-monorepo-release-strategy.md)（component-in-tag `server-vX.Y.Z` D5）
- SWAS + ufw 不兼容实证（2026-05；原 memory 条目已退役，见 § A-Tight v2「SWAS bootstrap」行）
- CF → 未备案国内 ECS 525 实证（备案 D7 驱动；见 [ADR-0025](0025-frontend-cloudflare-pages-expo-web.md)）
- [docs/private/plans/2026-05/05-23-claude-config-meta-to-mono-p3-automation.md](../private/plans/2026-05/05-23-claude-config-meta-to-mono-p3-automation.md) sub-plan（Phase 3 build-image / deploy 落地）
