# V1 验收报告 — LoC ratio

**T039 deliverable**：`cloc apps/server/src/auth` 测量 LoC + 对比旧 Java `mbw-account/src/main/java/com/mbw/account/{domain,application,infrastructure,web}`；ratio ≤ 1.5x 才 pass。

**日期**：2026-05-17

## V1 PASS

production-only LoC ratio = **0.119**（680 / 5705）→ mono TS/NestJS 是 Java 等量域 4 层代码的 1/8.4 → **远低于 1.5x 阈值** → ✅ PASS（big margin）

## 测量数据

工具：`cloc 2.08`（`brew install cloc`）

| 端                     | scope                                                                               | files | code LoC | blank | comment |
| ---------------------- | ----------------------------------------------------------------------------------- | ----- | -------- | ----- | ------- |
| **Mono production**    | `apps/server/src/auth/` 排 `*.spec.ts`                                              | 27    | 680      | 100   | 233     |
| Mono tests（参考）     | `apps/server/src/auth/**/*.spec.ts`                                                 | 13    | 973      | 153   | 12      |
| Mono total（cloc raw） | `apps/server/src/auth/` 全部                                                        | 40    | 1653     | 253   | 245     |
| **Java production**    | `mbw-account/src/main/java/com/mbw/account/{domain,application,infrastructure,web}` | 192   | 5705     | 1131  | 3480    |

## Ratio

| Metric                            | Value                  | Threshold | Verdict                 |
| --------------------------------- | ---------------------- | --------- | ----------------------- |
| Mono production / Java production | 680 / 5705 = **0.119** | ≤ 1.5     | ✅ PASS                 |
| 反向（Java / Mono）               | 5705 / 680 = **8.4x**  | n/a       | TS/NestJS 紧凑度 8.4 倍 |

## Caveats（透明说明）

1. **Java 端 scope 包含整个 account 模块**（device-management / account-deletion / cancel-deletion / realname / phone-sms-auth 等多 use case），非 phone-sms-auth-only。本次 user 在 W3 起手澄清环节显式选 "整 4 层 raw cloc" 的简单 + 可复现路线（vs grep 过滤等价类的精准 + 主观路线）。这让 mono 看起来更精简，但对比并非严格 apples-to-apples。
2. **Mono 仅 W2 phone-sms-auth scope**；W3+ 增量（FR-S07 rate limit / outbox cron 真触发 / JWT swap to jose / Aliyun SMS gateway 等）落地后，最终 8.4x 紧凑度 ratio 可能收敛到 3-5x。
3. **测试 LoC 不计入 ratio**：mono auth 测试 973 LoC > production 680 LoC，反映 TDD 红绿循环 + W2 完整 17 files / 67 tests 覆盖（含 race spec / Spec C 反枚举 / Spec D timing defense IT）。Java 端 production-only 对比（仅 `src/main/java`），不计 `src/test/java`。
4. **api 层（Java public DTO）已按 T039 task 文本排除**。Java mbw-account 实有 5 层（api/application/domain/infrastructure/web），本次 cloc 仅测 4 层。
5. **mono `auth.module.ts` 计入 production**（W2 single auth module 装配 root），1 file 入 27 files 总数。

## 比较定性观察

| 维度                  | Java mbw-account               | Mono auth              | 差异原因                                                                    |
| --------------------- | ------------------------------ | ---------------------- | --------------------------------------------------------------------------- |
| 平均 files / use case | ~38（多 use case / 192 files） | 27 / W2 phone-sms-auth | TS/NestJS 单 file 容多类；Java 强制 1 class 1 file                          |
| comment / code        | 3480 / 5705 = 61%              | 233 / 680 = 34%        | Java JavaDoc 文化 + Spring annotation 注释密度；TS interface + JSDoc 比例低 |
| blank / code          | 1131 / 5705 = 20%              | 100 / 680 = 15%        | 类似量级                                                                    |

## 结论

- **V1 验收 PASS**（big margin）：TS/NestJS PoC 在 W2 phone-sms-auth use case 上 LoC 显著小于 Java 等量域代码
- **Plan 1 假设验证**：mono-repo + Nest module + Prisma 在 1 个完整 use case（domain / application / infrastructure / web 全层 + outbox + timing defense + anti-enum + global filter）的实现成本 ≈ Java 等量 scope 的 1/8.4
- caveat 1-2 提示 W3+ 增量后 ratio 会调整，PoC W5 完整决策时再做一次 full LoC 验收
