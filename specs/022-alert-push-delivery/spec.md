---
feature_id: 022-alert-push-delivery
modules: [alert]
owners: ['@zhangleizlpd']
depends_on: ['021-alert-management']
migration_refs: ['20260607_1714_create_alert_push_tables']
status: implemented
created_at: '2026-06-07'
updated_at: '2026-06-07'
spec_kit_version: '>=0.8.5,<0.10.0'
orchestrator_compat: '>=0.2.0'
web_compat: untested
web_compat_notes: '推送为 native-only 能力：web 端推送初始化/RegID 上报全程 no-op（PoC #364 已落平台分流双文件先例）。mobile 新增 1 个 UI 节点（首启隐私政策弹窗，clarify Q2 纳入）+ 推送初始化；首启弹窗在 web 端的行为（弹/不弹）plan 阶段定；web export 未冒烟（draft，untested）。'
agent_friction_observed: false
perf_budgets:
  - endpoint: 'PUT /api/v1/alert/push-binding (RegistrationID 上报绑定)'
    p95_ms: 100
    p99_ms: 200
  - endpoint: 'DELETE /api/v1/alert/push-binding/{registrationId} (登出解绑)'
    p95_ms: 100
    p99_ms: 200
state_branches:
  - '首启隐私弹窗 (022 新增节点): 首次启动 → 弹隐私政策；同意 → 持久化并进入 App（后续启动不再弹）；不同意 → 退出/停留，不进主界面'
  - '隐私 gate: 用户未同意隐私政策 → 推送 SDK 永不初始化、零网络行为零上报；同意后初始化'
  - '绑定生命周期: 登录态 + SDK 注册成功 → RegistrationID 上报绑定到账号（RegID 全局唯一，换账号登录即整体转绑、旧绑定失效）；登出 → 解绑，该设备不再收到该账号预警推送'
  - '触发→推送解耦: AlertTrigger 流水落库成功 → 异步产生推送任务；推送链路任何失败不影响流水与消息中心（App 内消息为兜底真相）'
  - '送达分支: App 在线/后台 → 即时送达；华为设备杀进程 → 厂商通道系统级送达；非华为设备杀进程 → 重开 App 后离线补达'
  - '推送失败: 可重试错误 → 有限次重试；最终失败 → 留痕可观测，不再重试（消息中心兜底，不丢预警）'
  - '通知点击: 点击通知 → 打开 App 进入预警消息中心（含冷启动路径）；点击回调不可靠机型 → 既有未读角标 + 消息中心兜底'
  - '无效目标: RegistrationID 失效/已解绑 → 从推送目标剔除，不产生重试风暴'
---

# Feature Specification: 预警推送送达（Alert Push Delivery — 极光推送 Android）

> ⚠️ **[ARCHITECTURE PARADIGM (2026-06-07)]**
> server 段按 **Flat + Anemic + Moat** 范式（[ADR-0043](../../docs/adr/0043-server-flat-module-paradigm.md)）。**bounded context 归属为 plan 阶段决策**：021 已留 notification ctx seam（"V1 消息=仅预警触发，暂归 alert ctx"）——本 feature 的推送出口（设备绑定 + 推送 adapter）落 alert ctx 还是触发 [ADR-0032](../../docs/adr/0032-backend-bounded-context.md) Q4 立 notification ctx，plan 阶段按 catalog 7 问定稿。触发→推送走 **transactional outbox** 解耦评估事务与推送 IO（plan D2 定稿：alert 自有 `push_delivery` 专表、same-ctx 异步消费，不碰 security/outbox 通用事件表；ADR-0033 pattern 语义保留、载体换业务专表）。
>
> 📌 **[已定决策（PoC #364 实证 + user 拍板，不再开放讨论）]**
> 聚合商 = **极光推送免费版**（时效容忍 5 分钟；厂商通道 30% 占比可接受；`secondary_push` 默认策略；升级信号 = 日活 >5k / 分群需求）。客户端集成方式 = 已合入的本地 config plugin（#364，`apps/mobile/plugins/with-jpush.js`）。展示 = 自建 importance=HIGH 通知渠道 + 服务端指定 channel_id（PoC 实证默认渠道 importance=3 不弹横幅）。技术细节单一来源：local-only experience `docs/experience/2026-06/06-07-jpush-android-poc.md`。

**Feature Branch**: `022-alert-push-delivery`
**Created**: 2026-06-07
**Status**: Clarified（clarify 2026-06-07 2Q：① 设备绑定语义=一设备一账号、RegID 全局唯一登录转绑；② 首启隐私政策弹窗纳入 022 范围（现状无同意节点，grep 实证）。见 § Clarifications）
**Module**: `alert`（推送出口归属 plan 定稿，见上方 paradigm 注）
**前置依赖**: [021-alert-management](../021-alert-management/spec.md)（AlertTrigger 触发流水 + 消息中心 = 推送的事件源与兜底面）+ PoC #364（mobile 极光集成基础）
**Input**: User description: "021 预警推送送达（alert push delivery）：预警触发流水（AlertTrigger，#359 评估引擎产出）落库后，通过极光推送 JPush（免费版）把预警通知推送到用户 Android 手机，用户不打开 App 也能收到。范围：① mobile 侧 JPush 集成正式化——隐私同意 gate 之后才 init SDK、RegistrationID 上报 server 与账号绑定、自建 importance=HIGH 通知渠道（channel_id 常量化）；② server 侧推送出口——消费预警触发事件（Outbox 异步解耦，推送失败不影响评估事务、可重试）、极光 REST API push adapter（Basic auth，secondary_push 默认策略，按 RegistrationID 定向，payload 指定 channel_id，文案用 AlertTrigger 快照字段渲染）；③ 华为厂商通道接入——华为开发者账号 + AGC Push Kit、极光控制台厂商通道配置、客户端华为厂商插件（重打包）、预警消息申报"服务通讯类"避开运营消息日限额，目标=杀进程状态下预警必达；④ 通知点击打开 App 进预警消息中心（华为/小米点击回调不可靠机型由既有消息中心 + 未读角标兜底，不依赖通知 payload 跳转）。已定决策（PoC 实证，不再开放讨论）：聚合商=极光免费版（时效容忍 5 分钟、厂商通道 30% 占比可接受）；客户端集成方式=已合入的本地 config plugin（#364）。非目标：iOS/APNs（无 Apple 付费开发者账号，留后续）；小米/OPPO/vivo 等其他厂商通道（OPPO 需企业资质）；盘中实时评估改造（独立 backlog）；纯血鸿蒙 HarmonyOS NEXT 触达（Expo 无该平台支持，App 本体不可达）。"

## Clarifications

### Session 2026-06-07

- Q: 一台设备的 RegistrationID 同一时刻可以绑定几个账号？切换登录时如何处理？ → A: 一设备一账号——RegID 全局唯一，新账号登录即整体转绑（旧绑定自动失效），登出即解绑
- Q: 首启隐私同意弹窗是否纳入 022 范围？（grep 实证 mobile 现状无任何隐私同意节点） → A: 纳入——新增首启隐私政策弹窗，同意前 App 不初始化任何采集类 SDK，推送 gate 挂其上（兼作 US2 华为上架审核硬门槛的前置）

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 预警触发后手机收到通知（Priority: P1）

用户给自选股设了价格预警。当晚预警条件命中（EOD 评估触发），用户手机通知栏收到一条预警通知（弹横幅），显示股票名与命中条件（如"招商银行 跌至 30.00 预警价"）。点击通知打开 App，落在预警消息中心，看到对应消息详情。此时 App 可能在前台、后台，设备已登录该账号。

**Why this priority**: 这是 feature 的核心价值闭环——预警从"打开 App 才知道"变成"主动找到用户"。没有它，021 的预警能力对不常开 App 的用户形同虚设。

**Independent Test**: 设备登录 + 制造一条预警触发（评估 CLI 或测试数据）→ 手机通知栏 5 分钟内出现横幅通知 → 点击进入消息中心见对应消息。仅此一个 story 即构成可交付 MVP（在线/后台场景覆盖绝大多数实际使用）。

**Acceptance Scenarios**:

1. **Given** 已登录且已同意隐私政策的 Android 设备（App 在前台或后台）, **When** 该账号的一条预警触发（流水落库）, **Then** 5 分钟内手机通知栏出现横幅通知，内容含股票名与命中条件描述
2. **Given** 通知栏有一条预警通知, **When** 用户点击该通知, **Then** App 打开（含冷启动）并进入预警消息中心，对应消息可见
3. **Given** 同一评估轮多条预警同时触发, **When** 推送送达, **Then** 每条触发对应一条独立通知，与消息中心条目一一对应
4. **Given** 推送链路故障（聚合商不可用）, **When** 预警触发, **Then** 触发流水与消息中心不受影响（打开 App 仍能看到预警），推送失败留痕可观测

---

### User Story 2 - 杀进程/离线状态下预警必达（华为厂商通道）（Priority: P2）

用户晚上手滑把 App 从最近任务划掉了（进程被杀）。预警触发后，华为设备用户依然在通知栏收到预警通知（由手机系统级推送服务代收）；非华为 Android 设备用户在下次打开 App 时收到补达通知。

**Why this priority**: "必达"是预警类通知的核心承诺，但依赖外部门槛（华为开发者账号 + 应用市场上架 + 厂商通道审核），周期不可控，故与 P1 解耦独立交付。P1 先上线已覆盖在线/后台主场景。

**Independent Test**: 华为真机杀进程 → 制造触发 → 通知栏 5 分钟内收到（不打开 App）。非华为路径：杀进程 → 触发 → 重开 App → 补达通知出现。

**Acceptance Scenarios**:

1. **Given** 已登录的华为设备，App 进程已被杀, **When** 预警触发, **Then** 5 分钟内通知栏收到预警通知（无需打开 App）
2. **Given** 已登录的非华为 Android 设备（无厂商通道），App 进程已被杀, **When** 预警触发, **Then** 当时收不到；重开 App 后该通知离线补达
3. **Given** 华为厂商通道送达的通知, **When** 用户点击, **Then** 与 P1 同样进入消息中心（点击回调不可靠时，消息中心未读角标兜底呈现该预警）

---

### User Story 3 - 推送绑定的生命周期（登录绑定 / 登出解绑）（Priority: P3）

用户在新手机登录，该设备开始收到自己的预警推送；在旧手机退出登录后，旧手机不再收到该账号的预警推送。用户始终只在"当前登录着自己账号的设备"上收到自己的预警。

**Why this priority**: 正确性与隐私边界（换设备/借设备场景），但依赖 P1 的绑定机制先存在；低频场景，兜底面（消息中心）已有。

**Independent Test**: 设备 A 登录收推送 → 登出 → 再触发 → 设备 A 不再收到；设备 B 登录同账号 → 触发 → 设备 B 收到。

**Acceptance Scenarios**:

1. **Given** 设备已登录账号且推送绑定成功, **When** 用户登出, **Then** 该设备不再收到该账号的任何预警推送
2. **Given** 同一账号在两台设备登录, **When** 预警触发, **Then** 两台设备都收到通知
3. **Given** 设备曾登录账号 A（含未正常登出路径）, **When** 账号 B 在该设备登录, **Then** 设备推送标识整体转绑到 B——A 的预警不再推到该设备，B 的预警开始推到该设备
4. **Given** 未同意隐私政策的全新安装, **When** 任何操作, **Then** 推送能力零初始化、零网络行为、零设备标识上报；同意后（下次启动起）推送能力才激活

---

### Edge Cases

- 用户同意隐私政策但**系统通知权限关闭**：推送送达但不展示——App 内消息中心兜底；设置页可引导开启（引导项 plan 阶段定）
- RegistrationID 获取是异步的：登录瞬间 ID 未就绪 → 就绪后补上报；上报失败 → 下次启动重试
- 触发量尖峰（大跌日同轮大量触发）：逐条推送不聚合（V1 决策见 Assumptions），预警属服务通讯类不受厂商运营消息日限额
- 推送目标失效（卸载 App / RegistrationID 过期）：从推送目标剔除，不产生重试风暴
- 离线/弱网登出：解绑请求失败仍放行登出（best-effort）→ 绑定残留至该设备下次任意账号登录转绑或推送命中失效清理；残留窗口自用接受（plan D9）
- 离线补达的时效边界：离线消息有保留时长上限（天级），超期未打开 App → 推送过期丢弃，消息中心仍保留完整记录
- 厂商通道免费档用量占比限制（30%）触顶：回落聚合商自有通道（在线可达/离线等补达）——已接受的已知约束
- 通知内容含股票名与价格阈值（用户自设数据），锁屏可见性遵循系统/用户设置，不含账号身份信息

## Requirements _(mandatory)_

### Functional Requirements

- **FR-001**: 推送能力 MUST 在用户同意隐私政策之后才初始化；未同意状态下 MUST 保持零初始化、零网络行为、零设备标识收集
- **FR-002**: 已登录设备 MUST 在推送注册成功后将设备推送标识上报并绑定到当前账号；获取/上报失败 MUST 有重试路径（至迟下次启动）
- **FR-003**: 用户登出时 MUST 解除该设备与账号的推送绑定；解绑后该设备 MUST NOT 再收到该账号的预警推送
- **FR-004**: 预警触发流水落库成功后 MUST 异步产生对该账号全部绑定设备的推送任务；推送链路的任何失败 MUST NOT 影响触发流水与 App 内消息中心
- **FR-005**: 推送通知内容 MUST 由触发流水的快照字段渲染（股票名、命中条件、实际值），MUST NOT 依赖触发后回查活动预警规则
- **FR-006**: 预警通知 MUST 默认以横幅（heads-up）强度展示（高优先级通知渠道）；渠道标识 MUST 作为不可变契约管理
- **FR-007**: 华为设备在 App 进程被杀状态下 MUST 通过系统级厂商通道送达（预警消息按"服务通讯类"申报）；非华为 Android 设备杀进程场景 MUST 在重开 App 后离线补达
- **FR-008**: 点击预警通知 MUST 打开 App 并进入预警消息中心（含冷启动）；点击回调不可靠机型 MUST 由既有消息中心 + 未读角标兜底，核心信息获取 MUST NOT 依赖通知点击 payload
- **FR-009**: 推送发送失败 MUST 对可重试错误有限次重试；最终失败 MUST 留痕可观测（计数/日志），且消息中心兜底保证预警不丢
- **FR-010**: 推送目标失效（解绑/标识过期/卸载）MUST 从后续推送中剔除
- **FR-011**: App MUST 在首次启动时展示隐私政策同意弹窗（022 新增，现状无此节点）；用户同意前 MUST NOT 进入主界面、MUST NOT 初始化任何数据采集类第三方组件（含推送）；同意状态 MUST 持久化（后续启动不再弹）；不同意 MUST 可退出 App 或停留弹窗（不静默放行）

### Key Entities

- **设备推送绑定（Device Push Binding）**: 账号 ↔ 设备推送标识（RegistrationID）的绑定关系；属性含账号、设备推送标识、平台、绑定/更新时间；生命周期由登录（建立/刷新/转绑）与登出（解除）驱动；一个账号可绑定多台设备，但**一个设备标识同一时刻只绑一个账号**（RegistrationID 全局唯一，新账号登录即整体转绑、旧绑定自动失效——杜绝前账号预警推到现登录用户，per Clarifications 2026-06-07）
- **推送任务/投递记录（Push Delivery）**: 一次触发对一台绑定设备的推送尝试；属性含来源触发流水、目标设备、状态（成功/重试中/最终失败）、时间；与 AlertTrigger 的关系为 1:N（每触发 × 每绑定设备）——是否独立持久化还是复用 Outbox 事件状态，plan 阶段定

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: App 在线/后台状态下，预警触发后 ≤5 分钟内设备通知栏出现对应通知（验收实测 ≥10 次触发全达）
- **SC-002**: 华为真机杀进程状态下，预警触发后 ≤5 分钟内通知栏收到通知（厂商通道实测 ≥10 次，送达率 100%；该项为厂商通道灰度验收 gate）
- **SC-003**: 点击通知（前台/后台/冷启动三态）100% 落在预警消息中心且对应消息可见
- **SC-004**: 未同意隐私政策的安装包，抓包/审计可证推送相关零网络行为（合规审计可过）
- **SC-005**: 登出后制造触发，该设备 0 推送送达；同账号另一登录设备正常送达
- **SC-006**: 人为制造推送链路故障（凭证错误/网络阻断），触发流水与消息中心 100% 不受影响，失败可在可观测面（日志/计数）定位

## Assumptions

- **V1 不聚合推送**：同轮多条触发逐条推送（与消息中心一一对应）。依据：单人使用 + 低频预警，触发量级小；预警申报服务通讯类无日限额压力。聚合策略留到真实噪音出现再议
- **多设备全推**：账号绑定的所有设备都收到推送（不做"最近活跃设备"挑选）。依据：自用场景设备数 ≤2，全推语义最简单且符合直觉
- **Android 最低支持版本具备通知渠道能力**（Android 8.0+）：现有用户群（自用 + 华为 HarmonyOS 4.x 双框架）满足
- **杀进程补达依赖聚合商离线消息保留**（天级上限、每设备条数有限）：超期/超条数的推送丢弃可接受，消息中心是完整真相
- **厂商通道前置门槛**（华为开发者账号、AGC 应用创建、应用市场上架要求、消息分类审核）由 user 线下办理，工期不可控——故 US2 独立于 US1 交付
- **推送凭证（聚合商 Master Secret）为 server 侧秘密**：仅存于服务端环境，永不入库/入客户端（PoC 期间暴露的凭证已重置/待重置）
- **现有隐私政策文案需补充推送 SDK 与厂商通道的数据收集声明**（合规清单项，非本 feature 的代码范围）
