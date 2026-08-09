# Specification Quality Checklist: Device / Login Management

**Purpose**: Validate specification completeness and quality before proceeding to planning
**Created**: 2026-05-26
**Feature**: [spec.md](../spec.md)

## Content Quality

- [x] No implementation details (languages, frameworks, APIs)
- [x] Focused on user value and business needs
- [x] Written for non-technical stakeholders
- [x] All mandatory sections completed

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers remain
- [x] Requirements are testable and unambiguous
- [x] Success criteria are measurable
- [x] Success criteria are technology-agnostic (no implementation details)
- [x] All acceptance scenarios are defined
- [x] Edge cases are identified
- [x] Scope is clearly bounded
- [x] Dependencies and assumptions identified

## Feature Readiness

- [x] All functional requirements have clear acceptance criteria
- [x] User scenarios cover primary flows
- [x] Feature meets measurable outcomes defined in Success Criteria
- [x] No implementation details leak into specification

## Notes

- **clean-room (mode-1a)** 草稿：旧 Java `ListDevicesUseCase` / `RevokeDeviceUseCase` + `DeviceManagementController` + `DeviceMetadataExtractor` + 旧 IT 三源净室提取；旧技术词（Spring Modulith / Bucket4j / JPA / `did` claim 等实现细节）0 残留进 FR/SC。
- **3 处开放点已于 /speckit-clarify (2026-05-26) 结算**（见 spec § Clarifications Session 2026-05-26）：
  - **OQ1 `isCurrent` 机制** → **`x-device-id` 请求头比对**（不引入 JWT `did` claim，避免扩散 001/003 token 签发）。
  - **OQ2 `deviceName`/`deviceType` 采集** → **本批服务端补读**（FR-S14；client 已发头实证，纯 controller 改动）。
  - **US5 client 屏范围** → **延后**（settings shell 未建；本批 server-only，移入 § Out of Scope；spec-merge 约束随之收敛：字段以 server 为真相源、错误码沿旧 Java）。
- **本批 server-only**：mobile 登录管理屏延后，spec 已移除 Client FR/SC，US5 → Out of Scope。
- 边界 / 安全 / 并发硬规则锚自旧 Java 实证 + mono 既有范式：affected-count 乐观锁（禁 FOR UPDATE/Serializable）/ 反枚举字节级一致 404 / 原始 IP 不外露 / outbox 同 tx / 限流 4 桶（30·100·5·20 /60s）。
- **零 migration**：`refresh_token` 6 设备列 + 偏索引已 db-pull 确认在 `apps/server/prisma/schema.prisma`。
