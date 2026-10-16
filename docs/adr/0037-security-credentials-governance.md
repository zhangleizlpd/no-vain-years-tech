---
adr_id: ADR-0037
status: Accepted
applies_to: [apps/server, apps/mobile, security]
sunset_trigger: |
  - 切 OAuth2 / OIDC IdP (Keycloak / Auth0) — 全套 JWT 自管换托管
  - 切 RS256 + JWKS (per memory: HS256 适合 solo dev / RS256 适合多 svc)
  - 切 Vault / Secrets Manager (per ADR-0026 Phase 1 决) — secrets 注入路径改
  - 切 WebAuthn / passkey 取代 SMS code (per [ADR-0023](0023-sms-code-storage-hmac.md) sunset)
---

# ADR-0037: Security and Credentials Governance — gitleaks + env-sync + JWT HS256 双 token + secrets volumes

- Status: Accepted (2026-10-16) — 转 Accepted 前在 Proposed 期按实装**原地修订** §1 / §3 / §5 / §6（per [ADR-0031](0031-adr-governance.md) § ADR 修订策略：`Proposed` 可自由 in-place 改）；§4 已被 SOPS 取代（见 §4 引用块）。改了什么见文末「修订记录」
- Deciders: project owner
- Tags: backend / mobile / security / cross-cutting

## Context

Plan 1-2 实际安全状态:

1. **secrets 容易泄露** — `.env` 改但 `.env.example` 漏更新,新 dev clone 仓不知道要哪些 key;`.env.production` 实际 secret 误 commit 风险
2. **JWT 单 access token 无 rotation** — Plan 1 W3 实装单 access token,无 refresh / 无撤销机制,token 泄露后无法 force logout
3. **secrets 注入路径未定** — 现 `.env` 文件 mount 起步,但生产 image 是否 bake env / volumes mount / 云密钥 — 未定 (Phase 1 决)

## Decision

### 1. gitleaks pre-commit + CI

`.gitleaks.toml` 用 `useDefault = true`(继承 gitleaks 内置规则集 — 含 AWS / GCP / generic secret 等 pattern)+ `[[allowlists]]`(仓内已知非密文豁免,**只用 regex 判据、刻意不带 `paths`**),未自写 per-厂商 `[[rules]]`; `lefthook.yml` pre-commit hook 跑 `gitleaks protect --staged --no-banner`;CI `gitleaks` job(`.github/workflows/ci.yml`)**钉死 gitleaks 版本的二进制、扫全部历史**.

**CI 的两个选择**(理由详见 `ci.yml` 该 job 注释):

1. **CI 扫全史,不用 `gitleaks-action@v2`。** 该 action 在 push / pull_request 事件下只扫该事件的 commit 区间,而仓已公开、要防的是对全史的扫描;故 CI 跑 `gitleaks detect`(不带 `--log-opts` = 全史)。
2. **CI 与本机同一版本。** action 自带的 gitleaks 版本与本机不同,豁免语法在版本间有差异(`ci.yml` 注释记录了 2026-08-09 的实证:复数 `[[allowlists]]` 在旧版被静默忽略);钉同一版本,「本机验过」才等于「CI 也这样」。改版本号前先在新版本上跑一遍 `.gitleaks.toml` 的正例与负控制。

**一条 2026-08-08 修正的事实**:

1. **allowlist 的 `paths` 是文件级短路,不能与 regex 构成合取。** 8.30.1 实测:`paths` 命中即整个文件跳过(发生在 regex 求值之前),`condition` / `matchCondition` 均无法把两者变成 AND。故豁免只保留 regex 这一道精确判据 —— 详细实测记录在 `.gitleaks.toml` 注释。

**gitleaks 的能力边界**(它不是标识符守门):内置规则集靠熵与厂商前缀识别凭据,**抓不到裸 IP / 云账号 UID / ECS 实例 ID**。那一层由 `scripts/checks/check-identifier-boundary.ts` 独立承担,判据见 [`information-boundary.md`](../conventions/information-boundary.md)。

### 2. `.env` / `.env.example` 同步校验

`scripts/checks/check-env-sync.ts`(PR-6 ship；R-6 后续归入 `scripts/checks/` nx 项目):

```ts
// 对每个 .env.example: 提取 key 集合 K_example
// 对应 .env 必须有相同 key 集合 K_env (值不校验)
// K_example !== K_env → fail
// 同时 grep apps/**/*.ts 引用的 process.env.KEY,union 进 K_required
// K_required ⊄ K_example → fail
```

lefthook hook `check-env-sync`:staged `.env*` 任一改动触发。

### 3. JWT HS256 access + 不透明 refresh token 落 PG(单次使用轮换)

| Token       | Lifetime | 形态 / 存储                                                                                                         |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| **access**  | 15 min   | HS256 JWT,payload 仅 `sub` = accountId;无状态,只验签                                                                |
| **refresh** | 30 day   | 256-bit 随机串(**非 JWT**),只以 SHA-256 哈希存 `account.refresh_token` 行(原文不入库),行带 device 元数据 + 撤销时间 |

出处:`apps/server/src/security/security.module.ts`(`JwtModule` `expiresIn: '15m'`)、`jwt-token.service.ts`(签 / 验 access,`generateRefreshToken`)、`refresh-token-hasher.ts`、`refresh-token.service.ts`;需求 = [003-tokens](../../specs/003-tokens/spec.md) FR-S01 ~ FR-S07。

- HS256(单 `JWT_SECRET`,solo dev 简单;多 svc 时切 RS256,见 sunset trigger 2)
- **轮换**:refresh 时单事务内条件撤销旧行 → 签新 access + 新 refresh → 插新行(继承 device 血缘、IP 取当前、新 30 天窗口);任一步失败整体回滚(003 FR-S04 / FR-S05 / FR-S07)
- **单次使用、无宽限**:重放已撤销 token → 401 `INVALID_CREDENTIALS`(003 FR-S06);并发处理见 §5
- **登出 / 全端登出**:撤销该账号全部 active 行(`RefreshTokenService.revokeAllForAccount`)。access 无状态,验证只验签、不查撤销(`apps/server/src/auth/jwt-access.guard.ts`),故已签出的 access 在剩余有效期(≤15 min)内仍可用
- **存 PG 而非 Redis 的成文理由**:003 的用户决策(2026-05-25)「全生命周期 + 完整 device 元数据」(`specs/003-tokens/spec.md` 头部 Input 段),为 005-device-management 铺底

曾设想、未采纳:本 ADR Proposed 初稿的 Redis `jti:whitelist` 方案(access / refresh 均为带 `jti` 的 JWT,verify 必查白名单,logout 删 jti 立即失效)。003-tokens 按上述决策改为 PG 行。

### 4. secrets 注入 — 当前 `--env-file`，目标 volumes mount

> 🔁 **§4 Superseded (2026-06-28) — file-backed `/run/secrets` 路线作废，由 SOPS 取代**
>
> 本节描述的 `secrets:` 段 + `/run/secrets/<name>` 文件挂载硬化路线**从未实装**，已被 **SOPS（`sops exec-env` + age 私钥）** 实质取代（per [ADR-0026](0026-backend-deployment-topology.md) §「2026-06-22 Note」D4 + [`ops/runbook/secrets-sops.md`](../../ops/runbook/secrets-sops.md)）。配套 stub `infrastructure/docker-compose.yml`（及 `infrastructure/secrets/`）已删除。**本引用块只作废 §4**；其余各节的现状以各节正文为准（§3 / §5 / §6 已于 2026-10-16 按实装修订）。下方 §4 原文保留作被取代设计的历史记录。
>
> **当前实装**(per [ADR-0026](0026-backend-deployment-topology.md) D4):M1.1 部署用 `docker compose --env-file .env.production`(文件权限 + .gitignore 双保险)。下列 `secrets:` 段 + `/run/secrets` 文件挂载是**未实装的硬化目标**(本 ADR `Proposed`)。

- 禁 image ENV baking — 任何 secret 不写 Dockerfile `ENV`
- docker-compose 模板 `infrastructure/docker-compose.yml` 用 `secrets:` 段
- 生产部署:secrets 文件 mount 到容器 `/run/secrets/<name>`,应用启动读文件

当前 config 基建 = `apps/server/src/config/*.config.ts`(`registerAs` + Zod,启动 fail-fast 读 `process.env`);`/run/secrets/<name>` 文件 loader 属**未实装**的 secrets 设计(本 ADR `Proposed`),落地时在该 config 层加 file-first / env-fallback reader。

### 5. 并发 refresh:无 grace —— 服务端 exactly-once + 客户端单飞

- **服务端 exactly-once**:`RefreshTokenService.rotate` 用 `updateMany({ where: { id, revokedAt: null } })` 的 affected-count 作乐观锁,count = 0(已被并发轮换 / 撤销)→ 401 并回滚整个事务。隔离级 READ COMMITTED 即够;不用 SERIALIZABLE —— 它在 `revoked_at IS NULL` 偏索引上产生 SSI 假冲突,令独立 token 的并发轮换批量失败(T015 实证 72/100,见 `apps/server/src/security/refresh-token.service.ts` `rotate` 注释)。验收 = 003 US4:10 并发持同一 token 恰 1 成功 + 9 × 401;100 并发各持不同 token 0 错误。
- **客户端单飞**:`apps/mobile/src/auth/token-refresh.ts` `refreshOnce()` 让同一进程内的并发 401 共享一次 in-flight refresh(003 FR-C02 / US7),所以正常客户端不会拿同一 refresh token 并发呈递。
- **已知边界**(推断,未验证):单飞只在同一 JS 进程内生效;web 多标签页仍可能各自并发 refresh,输的一方 `refreshTokenFlow` 清会话、回到登录 —— 是体验问题,不是安全问题。

曾设想、未采纳:Proposed 初稿的 5s grace(旧 refresh 撤销后 5s 内仍接受,用 `jti:revoked-with-grace` TTL SET 兜底并发 race)。与 003 FR-S06「无宽限窗口」相悖;race 改由上面两层消除。

### 6. Secrets incident response

原计划的独立 procedure 文档(`docs/security/incident-response.md`)**未落地**。现有覆盖只有 [`ops/runbook/secrets-sops.md`](../../ops/runbook/secrets-sops.md) §6「轮换 / 应急」:单个密钥值轮换、age 密钥对轮换、age 私钥丢失后重建。

未覆盖(无成文 procedure):

1. **`JWT_SECRET` 轮换的会话影响** —— 换 secret 只让已签出的 access 失效;refresh token 以 SHA-256 存储、与 `JWT_SECRET` 无关(`refresh-token-hasher.ts`),客户端会静默续期。要强制全员重登,需另行撤销全部 active `refresh_token` 行,目前没有对应的脚本或 runbook。
2. **git 历史清洗** —— secret 已进入已推送的历史时的处置(改写历史 + 强推 + 轮换该值)。
3. **审计 / 通知** —— 泄露事件的记录与通知流程。

## Consequences

- 已落地:gitleaks(§1)/ check-env-sync(§2)/ access + refresh 生命周期(§3、§5,由 [003-tokens](../../specs/003-tokens/spec.md) 实装,含 `apps/server/src/auth/refresh-token.usecase.ts` 与全端登出)
- 未落地:volumes mount 模板(§4,已被 SOPS 取代)、incident-response 文档(§6,缺口见该节)
- secrets 注入路径已由 SOPS 定下(§4 引用块),不再需要原计划的「云密钥服务接入」amend 段

## Trade-offs

- HS256 单 secret(JWT_SECRET 全 svc 共享)— solo dev OK,scale 后切 RS256 (sunset trigger 2)
- 无 grace:同一 refresh token 的并发呈递只成功一次,其余被打回登录;靠客户端单飞避免正常路径撞上(§5),代价是单飞覆盖不到的场景(如 web 多标签页)会多一次重登
- access 无状态:登出后已签出的 access 在 ≤15 min 内仍可用 —— 换来鉴权路径不查库(§3)

## References

- memory obs (3953-3957 E3 Security Governance decisions)
- [ADR-0023](0023-sms-code-storage-hmac.md)
- [ADR-0026](0026-backend-deployment-topology.md)
- [003-tokens spec](../../specs/003-tokens/spec.md)(§3 / §5 的需求来源)

## 修订记录(2026-10-16,Proposed 期 in-place)

转 Accepted 前按实装改写,per [ADR-0031](0031-adr-governance.md) § ADR 修订策略:

- §1:CI 由「`gitleaks-action@v2`、不扫全史」改为实况「钉死版本二进制、扫全史」
- §3:Redis `jti:whitelist` 双 JWT 方案 → PG `refresh_token` 行 + 不透明 refresh token(原方案在 §3 末尾留一句)
- §5:5s grace 算法 → 无 grace,服务端 exactly-once + 客户端单飞(原方案在 §5 末尾留一句)
- §6:procedure 文档未落地 → 指向 `secrets-sops.md` §6,并列出三项未覆盖缺口
- §4 引用块:删掉「§3 / §5 / §6 仍为活决策」的断言;Consequences / Trade-offs 同步
