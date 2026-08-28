# Golden Sample 注册表

> SDD impl 子 agent 的「照抄结构」单一索引。`/sdd-auto-impl` 派单前按 task kind 查本表，把样板路径塞进子 agent brief（per [Phase 1 计划](../private/plans/2026-06/06-13-sdd-phase1-impl-quality-injection.md) Tier 3，本机私有未公开）。
>
> **照抄结构 / 命名 / 布局，不照抄业务逻辑。** 样板文件头**必带** `// GOLDEN SAMPLE` banner —— `scripts/checks/check-golden-sample-registry.ts` 守双向（表里每条路径必存在且有 banner；有 banner 的文件必在表里），PR 门 + lefthook 都跑。
>
> **分工（与 impl playbook 的边界）**：本表 = 「task kind → 样板文件」**索引**（WHAT / WHERE，单一真相源）；对应**工程纪律**（HOW / WHY，如 RHF 4 铁律 / React Query 缓存失效根因 / 并发事务范式）见各 [mobile](mobile-impl-playbook.md) / [server](server-impl-playbook.md) impl playbook 相应段（关键行「学什么」列已注 § 锚，如数据层 → § 8）。**playbook 不再各养一张聚合样板表**（避免三处 drift），只就地点名 + 链回本表。

## task kind → 样板

| Task kind                            | 样板路径                                                                                      | 学什么                                                                                                                                            | 不适用 / 边界                                                                 |
| ------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 表单逻辑（RHF 4 铁律）               | `apps/mobile/src/auth/use-login-form.ts`                                                      | RHF + zodResolver hook 分层（Controller≠register / 表单态≠副作用态 / isSubmitting 单源 / 错误+a11y）；纪律 → mobile playbook § 1                  | FROZEN 拦截态 + SMS 倒计时是 login 专属，标准编辑表单勿整屏照抄               |
| 编辑表单屏（最小标准）               | `apps/mobile/app/(app)/settings/account-security/name-edit.tsx`                               | 最小标准编辑屏布局（无 modal / overlay 噪声）                                                                                                     | —                                                                             |
| 富状态机登录屏（进阶参照）           | `apps/mobile/app/(auth)/login.tsx`                                                            | 复杂表单的状态机组织：FROZEN 拦截 modal + success overlay + SMS 倒计时                                                                            | login 专属，标准表单**勿整屏照抄**（用上两行）                                |
| Server CRUD（单 ctx）                | `apps/server/src/account/update-display-name.usecase.ts`                                      | 扁平 + 贫血 + `*.rules.ts` 纯函数 + 直注 PrismaService + `@map` row 投影（bio/display-name/gender 三候选中噪声最少）；纪律 → server playbook § P1 | —                                                                             |
| Server 跨 ctx 编排                   | `apps/server/src/auth/phone-sms-auth.usecase.ts`（+ `account/commit-phone-login.usecase.ts`） | 两段式 Inspect（读）/ Commit（写）护城河 + `// CROSS-CONTEXT-SYNC` 注入注释 + 并发注册 P2002/P2034 双形态见 server playbook § P3                  | timing pad + 反枚举折叠是 public 无 token 探测面专属，通用跨 ctx 勿照搬       |
| UI 列表 / badge                      | `apps/mobile/src/ui/MarketBadge.tsx` + `apps/mobile/src/ui/market-badge.rules.ts`             | 组件 + 纯函数规则（`*.rules.ts`）分离                                                                                                             | —                                                                             |
| 数据层 mutation + 缓存失效（mobile） | `apps/mobile/src/ideation/use-session-mutations.ts`（另一形态：`chat/use-conversations.ts`）  | mutation 共置失效 list key —— `onSuccess` 焊进 wrapper，调用方拿到的就是自带失效的 hook；改 list-visible 字段（title/status/updatedAt）必失效列表 | 仅 mobile（React Query FE 关注，server 无 RQ）；详见 mobile-impl-playbook § 8 |

## 测试样板（横切 —— 每个 impl task 都带测试）

测试不是一种 task kind，是**每个 task 的必带面**。照抄前先按 [`testing.md`](testing.md) §4 定 **size**（默认跑起来要不要容器 / 浏览器 / 本机 server），再取对应样板 —— **size 决定后缀，后缀由 `check-test-size.ts` 在 PR 门硬拦**。

| size × 形态                    | 样板路径                                                         | 学什么                                                                                                                                                    | 不适用 / 边界                                          |
| ------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **Small** 纯逻辑单测           | `apps/server/src/optionsdesk/radar-cursor.spec.ts`               | 零外部依赖 + 与源码 colocate + 直接 import 被测纯函数与常量；`*.spec.ts` 后缀即 Small 档，落 `unit` project（Docker-free 内环）                           | 需要容器 / 浏览器 / 本机 server → 不是这档，往下一行   |
| **Medium** server IT（真 PG）  | `apps/server/test/integration/optionsdesk-045.anchor.it.spec.ts` | 从 `isolated-db.ts` 三入口取库（**别自己起 PG 容器**）+ 文件头写「为什么必须真 X」+ 直接 new 贫血 usecase 打真 `PrismaService`                            | 只要 Redis / 要验 `migrate deploy` 产物 → 见下两个变体 |
| ↳ 变体：验 migrate 产物        | `apps/server/test/integration/optionsdesk-045.schema.it.spec.ts` | 用 `setupEmptyDb()` —— 自己跑 `migrate deploy` 并验证其产物，模板克隆会把被测对象抽掉                                                                     | 只有 `*.schema.it.spec.ts` 这类需要                    |
| ↳ 变体：只要 Redis、不要 PG    | `apps/server/test/integration/queue-shutdown-order.it.spec.ts`   | 自起 `RedisContainer`（三入口都会白克隆一个用不上的 PG 库）+ 存储选型理由写进文件头                                                                       | 沾 PG 就回上面走三入口                                 |
| **Medium** mobile hermetic e2e | `apps/mobile/e2e/optionsdesk-anchors-radar.spec.ts`              | 网络边界**全 mock**（`mockJson`）+ 断言逐条对应 tasks 编号 + 用稳定 testID 定位；纪律 → [mobile-e2e-hermetic](../../.claude/rules/mobile-e2e-hermetic.md) | 契约对齐不归它（mock 挡住了真契约），归下一行          |
| **Medium** 契约冒烟            | `apps/mobile/e2e/contract-smoke/optionsdesk.contract.ts`         | 用**生成的** `@nvy/api-client` 打真 server；**写完从另一个端点读回**证真落库；专属 ticker + 末尾自清理保同 boot 内多 spec 幂等                            | 只验契约对齐 + 真落库，UI 交互归上一行                 |

> 存储入口选型 / 文件头理由 / vendor 门控登记这三条不在守卫覆盖内，决策流见 [`test-taxonomy-trigger`](../../.claude/rules/test-taxonomy-trigger.md)（写测试文件时自动加载），本表不复述。

## `~/ui` 可复用原语（mobile）

复用频次 ≥2 的 UI 原语必抽到 `apps/mobile/src/ui/`，**别重造**：新 UI 先 `cat apps/mobile/src/ui/index.ts`（导出即清单，本表不手抄）；design-token 走 `~/theme` 直搬**不重设计**（per [nativewind-mapping](../../.claude/rules/nativewind-mapping.md)）。
