---
feature_id: 012-broker-account-binding
modules: [portfolio]
owners: ['@zhangleizlpd']
status: implemented
created_at: '2026-05-29'
updated_at: '2026-06-02'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: 'portfolio 第二特性，依赖 01 立起的 portfolio 模块骨架（impl 顺序 01 先）。Web export 路径尚未冒烟（draft，untested）。本批走类 2 流程（mockup 先行）：spec → clarify → mockup → plan → tasks → impl；UI impl 定稿前补真后端冒烟（Playwright Expo Web）。端点路径为提案，OpenAPI contract 阶段定稿。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'GET /api/v1/portfolio/broker-accounts'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'POST /api/v1/portfolio/broker-accounts'
    p95_ms: 120
    p99_ms: 250
  - endpoint: 'DELETE /api/v1/portfolio/broker-accounts/{id}'
    p95_ms: 120
    p99_ms: 250
state_branches:
  - 'list (new user): GET → 仅系统「默认账户」一条（背后 id = account id，不可删）'
  - 'list (已绑): GET → 默认账户置顶 + 已绑券商按 createdAt；每条 = {id, brokerCode, brokerName, clientNo(raw, 客户端脱敏), isDefault}'
  - 'bind: POST {brokerCode∈字典, clientNo 非空} → 201 + 持久化；唯一性 = accountId+brokerCode+clientNo'
  - 'bind dup: POST 已存在的 (brokerCode, clientNo) → 4xx BROKER_ACCOUNT_DUPLICATE，不重复落库'
  - 'bind invalid: brokerCode 不在字典 → 4xx；clientNo trim 后空 → 4xx VALIDATION_FAILED'
  - 'delete user broker: DELETE 属本账号的已绑券商 id → 204 + 移除（其名下历史归属数据回落默认账户，import 未建时 V1 行为见 clarify）'
  - 'delete default: DELETE 默认账户 → 拒绝（4xx，系统账户不可删）'
  - 'delete others/not-found: DELETE 不存在 / 属他人账号的 id → 404（字节级一致，反枚举）'
  - 'unauth / 非 ACTIVE: GET/POST/DELETE → 401（边界，与既有 /me 一致路径）'
---

# Feature Specification: Broker Account Binding（券商账户绑定 — 持仓归属字典池）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-05-29)]**
> server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）；属 `portfolio` bounded context（[ADR-0032](../../docs/adr/0032-backend-bounded-context.md) 评估归 `/speckit-plan`，与 01 共模块）。**券商账户 ≠ `account`（用户身份）模块** —— 是 portfolio 内独立概念（PRD §5.4）；只读引用 account id 作默认账户种子，**不向 `account` 写入**。
>
> 🎯 **[流程 OVERRIDE — 走类 2（per PRD 02 §9）]**
> intrinsic 类 1，本批走类 2：`spec → /speckit-clarify → mockup（先行）→ plan → tasks → impl`。纪律：① clarify 干净再 mockup；② UI impl 定稿前真后端冒烟；③ mockup 复用 theme tokens，不重设视觉资产。

**Feature Branch**: `012-broker-account-binding`（设计阶段在 `investment`，impl 再开分支）
**Created**: 2026-05-29
**Status**: Clarified（clarify 2026-05-29：OQ1 删后归属=仅删行+语义文档化 / OQ2 客户号=server 返 raw+客户端脱敏；OQ3/OQ4 informed-default 结算，见 § Clarifications）
**Module**: `portfolio`（券商字典 + 用户券商账户 CRUD + 默认账户语义；依赖 01 立起的 portfolio 模块骨架）
**PRD**: [portfolio-02-broker-account-binding-prd.md](../../docs/prd/portfolio/portfolio-02-broker-account-binding-prd.md)
**Input**:

- 国内 A 股**无法通过 API 获取持仓**——portfolio 需要「券商账户归属字典池」：用户登记各券商账户，作为后续**导入资产数据时的归属标记底座**（per Master §3.2）。
- 券商账户**不是业务主键**（业务主键 = 市场 + 代码），仅作导入 / 对接时的**归属映射字段** + 自选列表过滤维度。一用户可绑多券商、多账号。
- 三页流转：**A 列表页 →（新建）→ B 绑定表单 →（选券商）→ C 券商选择弹层 → 回 B → 绑定 → 回 A**。
- 列表置顶一条系统「默认账户」（背后 = 当前账号 id，不可删）；无真实券商时导入默认归属到它。
- 券商字典 V1 硬编码静态清单（含 logo 打包）。客户号明文存储、列表脱敏展示。

## Context

- **两个独立 bounded context（勿混）**：本特性「券商账户」= portfolio 内**持仓归属字典**；与 PRD 01「市场准入」、与 `account`（用户身份 / auth / displayName）都是独立概念。
- **默认账户语义**：中文显示名「默认账户」/ 英文 business name 待 plan 锁（PRD 建议 `default`）；背后 id = account id，随账号自动存在、不可删、不可编辑客户号；= 无真实券商归属时的兜底归属桶。**不向 `account` 模块写任何东西**——只读引用 account id 作种子。
- **依赖 01**：portfolio NestJS module + Prisma `portfolio` schema 由 01（01 市场）首次立起；本特性在其中新增券商相关表 + use case。impl 顺序 01 先。
- **复用既有设施**：`JwtAuthGuard` / status==ACTIVE 兜底 / RFC 9457 ProblemDetail / `@nestjs/throttler` 限流 —— 引用不重立。
- **反枚举不变性**：端点受 JWT 保护；删除「不存在 id」与「属他人账号 id」折叠为字节级一致 404（不泄露归属）；未认证 / 非 ACTIVE → 401。
- **券商字典是系统静态**：`{ brokerCode, 券商名, pinyinInitials, logoAsset }`，国内主流券商清单 V1 硬编码 + logo 打包（变动需发版）；是搜索 / 简拼 / A-Z 索引数据源。
- **唯一性**：用户券商账户唯一键 = `accountId + brokerCode + clientNo`（同券商可多账号，不同客户号）。

## Clarifications

### Session 2026-05-29

- Q: 删券商「归属回落默认」V1 范围？（import 未建，无真实 position 数据可转移） → A: **仅删 broker-account 行 + 文档化「回落默认」语义**，真转移逻辑留 import 特性落地时实现——不建空 seam（当前无数据，YAGNI）。固化 FR-S06。
- Q: 客户号脱敏发生在哪？（明文存储已定） → A: **server 返 raw + 客户端脱敏**（仿 002 phone 先例：raw 在 JWT 保护下返回，前端 `maskPhone` 同款 mask 前 4 后 4 展示）；前端可按需展示完整值。固化 FR-S07。
- 以下经 **informed-default 结算**（非 user-facing，spec 内已标）：
  - **OQ3 默认账户落地形态** → **读侧虚拟派生**（不落实体行）：列表渲染时由 portfolio 据已认证 account id 合成默认账户条目；**避免在 account 创建流程挂 portfolio 写 hook 的跨 context 耦合**（per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）。已绑券商的 `accountId` 仅作归属外指，不需默认账户实体行。
  - **OQ4 客户号字符校验** → **宽松 + 禁控制字符**：trim 后非空即可（各券商客户号格式不一，不强制格式），但禁控制字符 / 零宽 / 行分隔符（沿用 002 displayName 同款禁字符集，防注入 / 不可见字符）。

## User Scenarios & Testing _(mandatory)_

### User Story 1 — [Server] 列出券商账户（含默认账户置顶）（Priority: P1）

已登录用户拉取自己的券商账户列表：系统「默认账户」恒置顶，其后是用户已绑券商（按创建序）。

**Why this priority**: 读侧基座——绑定 / 删除 / 自选过滤都依赖列表；默认账户置顶是兜底归属的可见锚。

**Independent Test**: Testcontainers PG；① 新账号 GET → 仅默认账户一条（isDefault=true，背后 id=account id）；② 预置该账号 2 条已绑券商 + 1 条他人账号券商 → GET → 默认置顶 + 本账号 2 条（他人不可见），每条含脱敏客户号。

**Acceptance Scenarios**:

1. **Given** 新账号无已绑券商，**When** authed GET，**Then** 200 + 仅默认账户（isDefault=true，无客户号 / 标「系统默认」）
2. **Given** 账号有 2 条已绑券商，**When** GET，**Then** 默认账户置顶 + 2 条已绑（按 createdAt），他人账号券商不出现
3. **Given** access token 过期 / 缺失 / 非 ACTIVE，**When** GET，**Then** 401（反枚举）

---

### User Story 2 — [Server] 绑定券商账户（校验 + 唯一性）（Priority: P1）

用户提交「券商 + 客户号」绑定：server 校验券商存在于字典 + 客户号非空 + 唯一性，通过则持久化。

**Why this priority**: 核心写动作；唯一性 + 字典校验是数据完整性刚需。

**Independent Test**: Testcontainers PG；① POST {brokerCode=有效, clientNo="3119...2466"} → 201 + 持久化，GET 含新条；② 重复 POST 同 {brokerCode, clientNo} → 4xx BROKER_ACCOUNT_DUPLICATE；③ POST {brokerCode 不在字典} → 4xx；④ POST {clientNo trim 后空} → 4xx VALIDATION_FAILED。

**Acceptance Scenarios**:

1. **Given** 字典含某券商，**When** POST {该券商, 非空客户号}，**Then** 201 + 持久化；GET 返回新条
2. **Given** 已绑 {券商X, 客户号Y}，**When** 再 POST {券商X, 客户号Y}，**Then** 4xx `BROKER_ACCOUNT_DUPLICATE`，不重复落库
3. **Given** brokerCode 不在字典，**When** POST，**Then** 4xx（拒绝未知券商）
4. **Given** clientNo 为空 / 仅空白，**When** POST，**Then** 4xx `VALIDATION_FAILED`（trim 后非空校验）
5. **Given** 同券商不同客户号，**When** POST 两条，**Then** 均成功（同券商多账号合法）

---

### User Story 3 — [Server] 删除券商账户（默认不可删 + 反枚举 + 归属回落）（Priority: P1）

用户删除某已绑券商；默认账户不可删；删除属他人 / 不存在的 id 返回字节级一致 404；删除后其名下历史归属数据回落默认账户。

**Why this priority**: 写动作 + 安全不变性（反枚举）+ 数据不丢（归属回落）。

**Independent Test**: Testcontainers PG；① DELETE 本账号已绑券商 id → 204 + 移除；② DELETE 默认账户 → 4xx（系统账户不可删）；③ DELETE 不存在 id / 他人账号 id → 均 404 字节级一致；④ 归属回落：删券商后其名下导入数据归属转到默认账户（import 未建时的 V1 行为见 § Open Questions）。

**Acceptance Scenarios**:

1. **Given** 本账号已绑某券商，**When** authed DELETE 该 id，**Then** 204 + 移除；GET 不再含
2. **Given** 默认账户，**When** DELETE 其 id，**Then** 4xx（系统账户不可删），列表不变
3. **Given** 不存在 id **或** 他人账号的 id，**When** DELETE，**Then** 均 404（字节级一致，反枚举）
4. **Given** 被删券商名下有历史归属数据，**When** 删除，**Then** 该数据归属回落默认账户（不丢；import 未建时见 § Open Questions OQ1）

---

### User Story 4 — [Mobile] 券商账户列表页（页 A）（Priority: P1）

用户进入「股票账户」列表页：看到置顶默认账户（系统默认标签，不可删）+ 已绑券商（每条左滑可删，二次确认）。

**Why this priority**: 主入口；列表是绑定 / 删除的承载页。

**Independent Test**: mock GET 返默认 + 2 已绑 → 渲染列表 → 断言默认置顶 + 「系统默认」标签 + 无左滑删除；已绑券商行含 logo + 名 + 「已绑定」标签 + 脱敏客户号 + 左滑出删除。（render/手势走 Playwright Web，逻辑走 vitest）

**Acceptance Scenarios**:

1. **Given** GET 返默认 + 已绑，**When** 渲染，**Then** 默认账户置顶（系统默认标签，无左滑删除入口）；已绑券商每条 = logo + 券商名 + 「已绑定」+ 脱敏客户号
2. **Given** 已绑券商行，**When** 左滑，**Then** 出现「删除」→ 点击弹二次确认
3. **Given** 右上角「新建」，**When** 点击，**Then** 进入页 B 绑定表单

---

### User Story 5 — [Mobile] 绑定流程（页 B 表单 + 页 C 券商选择弹层）（Priority: P1）

用户从页 A 新建 → 页 B（选券商 → 进页 C 弹层搜索/索引选券商 → 回 B 内联显示 → 填客户号 → 绑定）→ 回页 A。

**Why this priority**: 核心绑定 journey；多页流转 + 弹层选择是主交互。

**Independent Test**: mock 券商字典 + POST 成功；页 B 点「选择券商」→ 页 C 弹层（搜索框 + A-Z 索引 + 券商行 logo+名，无开户/无能力标签）→ 选中回页 B 行 1 内联显示券商 → 填客户号 → 点「绑定」→ 发 POST → 回页 A 列表含新条。校验：未选券商 / 客户号空 → 绑定按钮 disabled。

**Acceptance Scenarios**:

1. **Given** 页 B，**When** 点「选择券商」，**Then** 打开页 C 弹层：搜索（名称 / 简拼）+ A-Z 右侧索引 + 券商列表（logo + 名）；**无**「开户」按钮、**无**「两融/港股通」能力标签
2. **Given** 页 C 选中某券商，**When** 回页 B，**Then** 行 1 内联显示该券商 logo + 名（替代占位）
3. **Given** 已选券商 + 已填非空客户号，**When** 点「绑定」，**Then** 发 POST → 成功回页 A，列表含新条
4. **Given** 未选券商 **或** 客户号空，**When** 检查，**Then** 「绑定」按钮 disabled（不发请求）
5. **Given** 重复绑定（券商+客户号已存在），**When** 提交，**Then** 展示错误提示（重复，形态 mockup 定）

---

### User Story 6 — [Mobile] 删除二次确认 + 默认账户保护（Priority: P2）

用户左滑已绑券商删除 → 二次确认 → 移除；默认账户无删除入口。

**Why this priority**: 防误删 + 默认账户保护可感知。

**Independent Test**: 已绑券商左滑 → 删除 → 弹二次确认 → 确认 → 发 DELETE → 列表移除；默认账户行无左滑删除手势 / 无删除入口。

**Acceptance Scenarios**:

1. **Given** 已绑券商，**When** 左滑删除 + 二次确认，**Then** 发 DELETE，成功后列表移除该条
2. **Given** 默认账户行，**When** 尝试左滑 / 找删除入口，**Then** 无删除操作（系统账户）

---

### Edge Cases

#### Server Edge Cases

- **POST body 缺字段 / 类型错** → `VALIDATION_FAILED` 400
- **clientNo 前后空白** → trim 后校验非空、存储 trim 后值
- **clientNo 含控制 / 零宽字符** → 拒绝（沿用既有 displayName 校验同款禁字符集，per 002 FR-005）或仅 trim（具体严格度 plan 定；归属标记非凭证，倾向宽松但禁控制字符）
- **并发 POST 同 {brokerCode, clientNo}**（多端）→ 唯一约束兜底（DB unique index），竞态败者 4xx DUPLICATE（不重复落库）
- **DELETE 已删 id**（幂等）→ 幂等 200 或 404（与「不存在」一致；策略 plan 定，倾向 404 字节级一致反枚举）
- **券商字典为空 / logo 资产缺** → 字典是打包静态，缺失属构建期问题；运行时 logo 缺 → 占位图兜底（mockup 定）

#### Mobile Edge Cases

- **GET 列表失败** → loading / retry，不死锁
- **页 C 搜索无结果** → 空态文案
- **页 B 未选券商直接点绑定** → 按钮 disabled（不可点）
- **长券商名 / 长客户号** → ellipsize
- **左滑手势与列表滚动冲突** → 手势库默认行为（plan 定）
- **删除 in-flight 重复点** → 防抖 / 禁用

## Requirements _(mandatory)_

### Server Functional Requirements

- **FR-S01**: 系统 MUST 对已登录账号返回其券商账户列表：系统「默认账户」恒置顶（isDefault=true，背后 id = account id，随账号自动存在），其后为用户已绑券商（按 createdAt）。仅返回**本账号**数据（他人不可见）。
- **FR-S02**: 系统 MUST 支持绑定券商账户：入参 `{ brokerCode, clientNo }`；`brokerCode` MUST 存在于系统券商字典、`clientNo` trim 后 MUST 非空；通过 → 201 + 持久化。
- **FR-S03**: 唯一性 — 用户券商账户唯一键 = `accountId + brokerCode + clientNo`；重复绑定 MUST 拒绝（4xx `BROKER_ACCOUNT_DUPLICATE`）；同券商不同客户号 MUST 允许。
- **FR-S04**: 系统 MUST 支持删除**本账号**已绑券商（by id）；**默认账户不可删**（DELETE 其 id → 4xx 系统账户不可删）。
- **FR-S05**: 删除属他人账号 / 不存在的 id → MUST 字节级一致 404（不泄露归属，反枚举）。
- **FR-S06**: 删除已绑券商语义 = 其名下历史归属数据回落默认账户（不丢数据）。**V1 范围（clarify 2026-05-29）**：import 特性未建、当前无 position 数据 → V1 **仅删 broker-account 行**，「回落默认」语义留 import 特性落地时实现真转移（不建空 seam）。
- **FR-S07**: 客户号 MUST 明文存储（归属标记非登录凭证）。**脱敏位置（clarify 2026-05-29）**：server 在 JWT 保护下返回 **raw 客户号**，**客户端脱敏展示**（前 4 + 后 4，仿 002 phone `maskPhone` 先例）；前端可按需展示完整值。字符校验：trim 后非空 + 禁控制 / 零宽 / 行分隔符（沿用 002 displayName 禁字符集），不强制格式。
- **FR-S08**: 系统 MUST 提供券商字典（系统静态：`{ brokerCode, 券商名, pinyinInitials, logoAsset }`）作为页 C 搜索 / 简拼 / A-Z 索引数据源；V1 硬编码清单（具体清单 plan 定）。
- **FR-S09**: GET/POST/DELETE MUST 鉴权；缺失 / 无效 / 过期 / 非 ACTIVE → 统一 401 ProblemDetail（反枚举）。
- **FR-S10**: 错误响应 MUST 遵循 RFC 9457 ProblemDetail（全局 filter 映射）。
- **FR-S11**: 系统 MUST 对端点限流（复用 `@nestjs/throttler`，阈值 plan 定，tracker = JWT sub）；超限 429 + `Retry-After`。
- **FR-S12**: 券商账户属 `portfolio` context，**只读引用 account id 作默认账户种子，不向 `account` 模块写入**（bounded context 边界，per [catalog](../../docs/conventions/server-bounded-context-catalog.md)）。

### Mobile Functional Requirements

- **FR-M01**: 页 A 列表 MUST 置顶展示「默认账户」（系统默认标签，**无左滑删除入口**）+ 已绑券商（每条左滑可删）。
- **FR-M02**: 已绑券商每行 MUST = 券商 logo + 券商名 + 状态标签（「已绑定」/ 默认账户「系统默认」）+ 脱敏客户号（前 4 + 后 4，如 `3119****2466`）。
- **FR-M03**: 页 A 右上角「新建」MUST 进入页 B 绑定表单。
- **FR-M04**: 页 B 表单 MUST 含「选择券商」（→ 页 C）+「客户号」文本输入 +「绑定」按钮；选中券商后 logo + 名内联显示在行 1；**去掉**原图二「货币单位」行。「绑定」前校验：券商已选 + 客户号非空 → 否则按钮 disabled。
- **FR-M05**: 页 C 券商选择弹层 MUST 含：标题「选择券商」+ 返回；搜索框（名称 / 首字母简拼）；券商列表（logo + 名）；右侧 A-Z 索引。**去掉**右上角「开户」按钮 + **去掉**「两融 / 港股通 / 云条件单」能力标签。
- **FR-M06**: 删除已绑券商 MUST 二次确认；默认账户无删除入口。
- **FR-M07**: 视觉 MUST 复用 theme tokens；项目无 List-row / 左滑删除 / 搜索框 / 选择弹层 / A-Z 索引组件 —— 新组件视觉规格留类 2 mockup；券商 logo 品牌资产引入归 impl。
- **FR-M08**: 错误态（重复绑定 / 保存失败 / 网络错）MUST 有展示位（Toast / 行内，形态 mockup 定）。
- **FR-M09**: a11y — 列表行 / 按钮 / 弹层 / 搜索框 `accessibilityRole` + `accessibilityLabel`；左滑删除可达。

### Key Entities

- **Broker（系统静态字典）**：`{ brokerCode, 券商名, pinyinInitials, logoAsset }`——国内主流券商清单（华泰 / 中信 / 招商 / 东财 / 银河 / 平安 / 广发 / 东方……）。V1 硬编码 + logo 打包，变动需发版。
- **BrokerAccount（用户级，per account）**：`{ id, accountId, brokerCode, clientNo, createdAt }`——唯一性 = `accountId + brokerCode + clientNo`；clientNo 明文存储。
- **默认账户（DefaultAccount，系统语义）**：背后 id = account id；随账号自动存在、不可删、不可编辑客户号；无真实券商归属时的兜底归属桶；是否落实体行 vs 读侧虚拟派生见 § Open Questions OQ3。

## Success Criteria _(mandatory)_

### Server Measurable Outcomes

- **SC-S01**: 列表返回本账号全部券商账户（默认置顶 + 已绑），他人数据不可见（集成测试覆盖跨账号隔离）。
- **SC-S02**: 绑定校验全覆盖：有效绑定 201 / 重复 4xx DUPLICATE / 未知券商 4xx / 空客户号 4xx / 同券商多账号允许（集成测试 5 case）。
- **SC-S03**: 默认账户不可删（4xx）；删属他人 / 不存在 id 字节级一致 404（集成测试 + ProblemDetail 深等）。
- **SC-S04**: 删除已绑券商后归属回落默认账户语义生效（per OQ1 结算口径，集成测试覆盖）。
- **SC-S05**: 鉴权边界 401（未认证 / 非 ACTIVE）+ 限流 429（集成测试覆盖）。
- **SC-S06**: 客户号脱敏不变性（OQ2 结算：**server 在 JWT 保护下返 raw 客户号，脱敏在客户端**）——脱敏不变性是**客户端**断言：mobile `maskClientNo` 单测（前 4 + 后 4）+ Playwright 列表渲染断言不显示完整客户号；server 侧仅断言返回 raw（鉴权边界已由 401 反枚举保护）。
- **SC-S07**: portfolio module 边界 ESLint 0 violation；Prisma `portfolio` schema CI 通过。

### Mobile Measurable Outcomes

- **SC-M01**: 页 A 渲染默认置顶 + 已绑券商（logo + 名 + 状态标签 + 脱敏客户号）；默认账户无删除入口（vitest 逻辑 + Playwright Web）。
- **SC-M02**: 绑定 journey 真后端冒烟（Playwright Web，纪律②）：新建 → 选券商弹层（搜索 + A-Z）→ 填客户号 → 绑定 → 回列表含新条 → 截图归档。
- **SC-M03**: 校验：未选券商 / 空客户号 → 绑定按钮 disabled（不发请求）。
- **SC-M04**: 删除二次确认 + 默认账户保护（左滑删除仅对已绑券商生效）。
- **SC-M05**: 页 C 弹层无「开户」/ 无能力标签（grep / 渲染断言），搜索 + A-Z 索引可用。
- **SC-M06**: 视觉 0 硬编码——实现文件不含 theme token 外 hex / rgb（mockup-driven，grep）。

## Assumptions

- **依赖 01 portfolio 模块骨架**：portfolio NestJS module + Prisma `portfolio` schema 由 01 首立；本特性新增券商表 + use case（impl 顺序 01 先）。
- **券商账户 per-account 服务端持久化**：绑定 account，跨设备一致（与 01 同范式）。
- **券商字典 V1 静态硬编码**：含 logo 打包；后端可配置 V2+ 再议。
- **import 特性未建**：「删券商后历史归属回落默认」的真实 position 数据 V1 尚不存在（见 OQ1）。
- **鉴权 / 错误格式 / 限流复用既有设施**。
- **端点路径为提案**：`/api/v1/portfolio/broker-accounts*` 为提案，OpenAPI code-first contract 阶段定稿。

## Open Questions（已于 `/speckit-clarify` 2026-05-29 全部结算，见 § Clarifications）

- **OQ1 — 删券商「归属回落默认」V1 范围** → ✅ **仅删行 + 语义文档化**，真转移留 import 落地（FR-S06）。
- **OQ2 — 客户号脱敏位置** → ✅ **server 返 raw + 客户端脱敏**（仿 002 phone，FR-S07）。
- **OQ3 — 默认账户落地形态** → ✅ informed-default：**读侧虚拟派生**（不落实体行，避免 account 创建跨 context 写 hook）。
- **OQ4 — 客户号字符校验严格度** → ✅ informed-default：**宽松 + 禁控制 / 零宽字符**（FR-S07）。

## Out of Scope（本 feature 不做）

- **真实券商 OAuth / API 直连拉持仓**（A 股本就拉不到；本特性只做手动归属登记）。
- **资产导入流程**（Excel 解析 / 字段映射）——本特性只提供「归属券商」维度，导入单独 PRD。
- **海外券商**（富途 / 老虎 / IB）——V1 聚焦国内主流券商。
- **券商「默认 / 激活」概念**——不设（导入时逐次选归属券商）。
- **券商 logo 品牌资产来源**——impl 处理。
- **市场准入**（PRD 01）与**自选过滤器**（PRD 04，券商作过滤维度由 04 消费）。
