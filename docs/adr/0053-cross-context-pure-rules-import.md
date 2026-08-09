---
adr_id: ADR-0053
status: Accepted
applies_to: [apps/server]
sunset_trigger: |
  - 任一 `*.rules.ts` 文件出现带状态/带 IO 内容（class + DI / Prisma client 实例 / fs / net）→ 细分元素判据失效，立即重审（修复 = 拆出纯函数或收回放行边）
  - 第二个 ctx 申请 import 他 ctx 的 `*.rules.ts` → 重审是否升级为共享 package（packages/）而非继续点对点放行
  - marketdata 提供 indicator/复权查询服务（DI 形态）或前复权算法迁出 `adjusted-bars.rules.ts` → alert→marketdata-rules 边可收回
---

# ADR-0053: 跨 Context 纯函数 rules import — boundaries 细分 `marketdata-rules` 仅放行 alert

- Status: Accepted (2026-06-07)
- Deciders: @zhangleizlpd
- Tags: server / bounded-context / alert / marketdata / boundaries
- Relates: [ADR-0032](0032-backend-bounded-context.md)（bounded context 框架）/ [ADR-0043](0043-server-flat-module-paradigm.md)（扁平贫血范式，`*.rules.ts` = 纯函数层命名约定）/ [ADR-0048](0048-marketdata-portfolio-cross-layer-dependency.md)（Q7-B 直查先例）/ [ADR-0052](0052-alert-bounded-context.md)（alert 第 6 ctx，叶子）；实施载体 = [023-alert-eod-indicators](../../specs/023-alert-eod-indicators/spec.md)（plan D1）

## Context

023 预警指标扩展需要**前复权 bar 序列**喂指标纯函数（MA/MACD/KDJ/RSI/BOLL）。前复权换算算法（020 比值口径 / 跨段 prevClose / 防御语义）已单源落在 marketdata 的 `adjusted-bars.rules.ts`（纯函数：`deriveAdjustedBars(bars, factors, 'forward')`）。alert 取用该算法三选（plan D1 决策路径）：

1. **(a) alert 内重写** — 复制金融关键算法，drift 风险不可接受
2. **(b) marketdata 出 indicator 查询服务（DI 注入）** — 触发 catalog Q7-C 禁则 or 新建共享读服务，且 marketdata 反向吃进「指标」业务语义，方向错
3. **(c) alert 直接 import marketdata 的纯函数文件** — 零运行时耦合（无 DI / 无 IO，纯编译期依赖）、单向 alert→marketdata 不成环、算法单源

但 (c) 撞 ESLint boundaries 既有围栏：`alert → marketdata` 全禁（ADR-0052 alert 叶子，对 marketdata 仅 Q7-B Prisma 只读直查）。

## Decision

**取 (c)**，落地 = boundaries 元素细分而非整体放行：

1. `apps/server/eslint.config.mjs` 新增细分元素 `{ type: 'marketdata-rules', pattern: 'src/marketdata/*.rules.ts' }`，**声明序排在 `marketdata` 通配前**（boundaries 首匹配生效）
2. **唯一放行边 = `alert → marketdata-rules`**（alert 的 disallow 列表故意不含该 type）；marketdata 本体（adapter / usecase / module / repository）import 仍全禁
3. 其余 ctx（security / account / auth / portfolio）的 disallow 列表**显式补 `marketdata-rules`** —— 细分不得静默放宽既有围栏
4. `marketdata-rules` 自身 from 侧维持母元素同款禁边（不得 import auth / portfolio / alert）——纯函数不反向感知消费方

### 放行判据（新增同类边必须逐条过）

- **纯函数**：无 class + DI、无可变模块级状态、输入→输出确定
- **无 IO**：不 import Prisma client 实例 / Redis / fs / net（Prisma **命名空间类型**如 `Prisma.Decimal` 允许——编译期类型，零运行时连接）
- **算法单源诉求**：复制会产生金融/业务关键算法 drift，且服务化（DI）会让 provider 反向吃进消费方业务语义

### 防逃逸

`*.rules.ts` 文件名即契约：**禁止带状态/带 IO 内容混入 `*.rules.ts` 命名**逃逸进细分元素（见 sunset_trigger 第 1 条；PR review 关注点 + moat 探针管 Prisma 实例 import 面）。

## Consequences

- ✅ 前复权口径全仓单源；alert 指标层吃 marketdata 同一换算结果，与行情展示（015/016）逐 bar 一致
- ✅ 围栏粒度从「目录级 ctx」细化到「文件命名级纯函数层」，为后续同类复用留判据（而非先例即放行）
- ⚠️ `*.rules.ts` 命名从「ctx 内约定」升格为「跨 ctx 契约」——marketdata 重命名/移动 rules 文件成为 alert 的编译期破坏面（可接受：tsc + lint 双红即时暴露）
- ⚠️ 细分元素是点对点边（alert→marketdata-rules），非通用「rules 层互通」——其他 ctx 申请走 sunset_trigger 第 2 条重审
