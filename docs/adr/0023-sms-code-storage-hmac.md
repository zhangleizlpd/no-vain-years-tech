---
adr_id: ADR-0023
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - SMS code 升 6→8+ 位且要求加密存储 (HMAC 单向不可逆 → 需 reversible 加密)
  - 引入 TOTP / WebAuthn 取代 SMS 一次性码
  - 监管要求短信内容加密存储 (cn 等保 / 个保法 update)
---

# ADR-0023: SMS code 存储 — HMAC-SHA256 + constant-time compare（替换 bcrypt cost=12）

- Status: Accepted (2026-05-18)
- Deciders: project owner
- Tags: backend / security / cross-cutting

## Context

[FR-S06](../../specs/001-phone-sms-auth/spec.md) 要求 `/phone-sms-auth` 反枚举 3 个 401 路径（ACTIVE+码错 / ACTIVE+码过期 / ANONYMIZED+任意码）P95 wall-clock 时延差 ≤ 50ms。

W3 deferred Item 4 落地 `timing-defense.p95.it.spec.ts`（mono PR #23）实测 200-rep diff ≈ 193ms,违反阈值。**根因**:

| 路径               | `SmsCodeRedisRepository.verify` 触发 | bcrypt.compare(cost=12) | `BcryptTimingDefenseExecutor.pad`(cost=10) | 总耗时     |
| ------------------ | ------------------------------------ | ----------------------- | ------------------------------------------ | ---------- |
| P1 ACTIVE + 码错   | hash 存在 → bcrypt.compare(cost=12)  | ~150ms                  | + ~80ms                                    | **~230ms** |
| P2 ACTIVE + 码过期 | redis miss → null                    | 0ms                     | + ~80ms                                    | ~80ms      |
| P3 ANONYMIZED      | verify 不调用                        | 0ms                     | + ~80ms                                    | ~80ms      |

单边 ~150ms verify bcrypt 差让 pad 抹不平,与 spec FR-S06 P95 ≤ 50ms 不可兼容。

## Decision

SMS code Redis 存储**从 bcrypt(cost=12) 改 HMAC-SHA256 + `crypto.timingSafeEqual`**:

- `store(phone, code, ttl)` — `crypto.createHmac('sha256', SMS_CODE_HMAC_SECRET).update(code.value).digest()` 取 32-byte digest → base64url encode → `SETEX sms_code:<phone> ttl <digest>`
- `verify(phone, code)` — `GET sms_code:<phone>` → 若 null 返 null;否则同算法 HMAC `code.value` → `crypto.timingSafeEqual(stored, candidate)` constant-time 比较
- secret 从 env `SMS_CODE_HMAC_SECRET` 注入(同 `AUTH_JWT_SECRET` 管理风格,fail-fast via `authConfig` Zod schema)
- `BcryptTimingDefenseExecutor` 保留(纵深防御:抹平未来 verify 路径间任何残余时差,如 redis.get 抖动 / Phone.create 校验 / VO 构造等)

### 接口签名(无变更)

`SmsCodeRepository` port 接口签名保持不变(`store / verify / clear`);仅 infra impl(`SmsCodeRedisRepository`)内部算法替换,application 层 0 改动。

### ConfigModule wireup

`auth.module.ts` `SMS_CODE_REPOSITORY` provider 从 `useClass` 改 `useFactory`,`inject: [REDIS_CLIENT, authConfig.KEY]`(从 `authConfig` 读 `SMS_CODE_HMAC_SECRET`)。

## Consequences

### Positive

- **FR-S06 P95 ≤ 50ms 阈值可达** — 全 verify 路径 < 1ms,pad ~80ms 单边支配,3 路径均一
- **Constant-time compare** — `crypto.timingSafeEqual` 防 byte-by-byte timing leak,密码学层面无 weakness
- **CPU 节省** — `bcrypt.compare(cost=12)` ~150ms vs HMAC + timingSafeEqual ~1ms,每发码 + 每次 verify 都省 100x+ CPU;Plan 2+ 真用户后单 server 容量明显抬
- **运维简单** — HMAC secret 与 JWT secret 同管理面(env / k8s Secret / Aliyun KMS 等);轮换语义对齐(轮换期间双 secret 验证,新 store 用新 secret,新 store-old verify 失败即 expire)

### Negative / Trade-offs

- **新增 env `SMS_CODE_HMAC_SECRET`** — 部署清单 + 测试 setup + `.env.example` 都需加;但与 `AUTH_JWT_SECRET` 风格一致,新增运维负担可控
- **失去 bcrypt work-factor** — bcrypt cost=12 的设计意图是防"hash 库泄露后离线爆破"。SMS code 是 6 位数字 + 5min TTL + 5-strike auth-lock + 24h 10 次 rate-limit,本质上 **没有 password 的离线爆破威胁模型**(6 位数字 + 5min TTL 在线爆破期望成功率 5/100W × 5min/24h ≈ 1.7e-9,与 secret 不被偷的前提下 HMAC 比较冗余的安全余量相比 negligible);Redis hash 即便泄露,5min 内已 expire 0 价值
- **HMAC secret 泄露 = 全量 code 可离线伪造 hash** — 但攻击者要 RCE 拿到 server env 同时也能拿 redis 数据 + JWT signing key,attack chain 等价 admin compromise;不是 secret 漏出独占的新 attack surface
- **`BcryptTimingDefenseExecutor` 仍存在** — 看似 redundant(verify ~1ms),但保留作纵深:redis.get 抖动 / Phone VO 构造 / config 读取 / DB account 查询时差等任何**未列**的隐藏 1-5ms 差异都被 ~80ms pad 抹平。删 pad = 暴露任何未来引入的微差异为枚举信号
- **HMAC deterministic** — 同 code 同 secret 同 digest(不像 bcrypt salt 不同 hash 不同);Redis key `sms_code:<phone>` per-phone 隔离 + 5min TTL,deterministic 性质对 6 位 code 反枚举无削弱(攻击者本就知道 6 位 code 全集 10^6,本攻击面与 hash 算法无关)
- **secret 轮换需双读期** — 蓝绿 / 滚动部署期间新 verify(新 secret)对老 store(老 secret hash)失败,产生 false-negative;**缓解**:secret 轮换运维 SOP = 旧 secret deprecate 期 ≥ 5min TTL 自然过期,期间 0 用户影响(短时 SMS code 天然适合此 model)

## Alternatives Considered

- **Option A — 抬 BcryptTimingDefenseExecutor cost 10→12** — 拒绝:数学上无效。P2/P3 verify 0ms + pad cost=12 ~150ms 总耗时 ~150ms;P1 verify ~150ms + pad ~150ms = ~300ms,diff 仍 ~150ms。pad 单边抬不可能填平 verify 单边差
- **Option C — verify redis miss / anonymized 路径也跑 dummy bcrypt.compare(cost=12)** — 拒绝:让全路径变 ~150ms(SC-S01 主流程 P95 ≤ 600ms 仍 OK,但每请求多 ~150ms CPU 是真浪费);未来 bcrypt cost 涨更糟;反枚举"全员变慢"路线长期不健康
- **Option D — 改 spec FR-S06 P95 ≤ 50ms 阈值松到 200ms+** — 拒绝:实测 193ms diff,松到 200ms 仍不达标;松到 300ms 反枚举语义实质削弱(用户从感官 wall-clock 也能注意到 ~300ms 多个路径差);属于"业务-level surrender",不解决根因
- **改用 Argon2 / scrypt 替代 bcrypt** — 拒绝:同属"昂贵 KDF 函数"族,problem class 不变;且要求 work-factor 但 SMS code 没此需求
- **改用 PBKDF2 低 iteration 替代 bcrypt** — 拒绝:PBKDF2 同 KDF 族,即便 iteration=1 也比 HMAC 多 1 层 PBKDF2 KDF 包装,无收益;HMAC 是直接 primitive,更简洁
- **SMS code 存 plaintext** — 拒绝:Redis dump / RDB snapshot / replication 链路任一泄露 = TTL 期内全量 code 在 cleartext,即便 5min 窗口也是不必要的暴露面;HMAC + timingSafeEqual 是 OWASP 短时 token 共识(参 OWASP Cheat Sheet "Cryptographic Storage" + "Authentication" 章节)
- **改用 random nonce 替代 6 位数字 code** — 拒绝:SMS 文案 + 用户输入 6 位数字是 UX 既定约束(PRD § 5.2),与本 ADR 解决的 storage 算法问题正交

## Validation

- `SmsCodeRedisRepository` 单测覆盖:store / verify true / verify false / verify null after expire / verify null after clear / HMAC deterministic(同 code 同 secret 同 digest) / negative test(不同 code 不同 digest);Testcontainers Redis
- `timing-defense.p95.it.spec.ts` `RUN_PERF_IT=true PERF_IT_REPS=200` 实测 P95 diff ≤ 50ms PASS;200-rep 是 PoC 阶段 fast feedback,1000-rep nightly job 在 Plan 2 引入 dedicated slow-IT job 时启用
- Spec amend [FR-S06](../../specs/001-phone-sms-auth/spec.md) 末尾加 storage sub-clause + Changelog 2026-05-18 entry,记录从 bcrypt → HMAC 切换

## References

- [Plan 1 § B Security Posture](../private/plans/2026-05/05-18-plan1-backend-stack-poc.md)
- [`specs/001-phone-sms-auth/spec.md` FR-S06](../../specs/001-phone-sms-auth/spec.md)
- [`apps/server/src/auth/sms-code.store.ts`](../../apps/server/src/auth/sms-code.store.ts)（原 `auth/infrastructure/sms-code.redis.repository.ts`，ADR-0043 扁平化后改名）
- [`apps/server/test/integration/timing-defense.p95.it.spec.ts`](../../apps/server/test/integration/timing-defense.p95.it.spec.ts)
- mono PR #23 实证 200-rep diff ≈ 193ms(IT first ship 暴露 spec gap)
- OWASP Cheat Sheet Series — Authentication & Cryptographic Storage(HMAC + timingSafeEqual 短时 token 推荐)
- Node.js `crypto.timingSafeEqual` constant-time compare 文档
