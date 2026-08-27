# 业务命名约定

> mono-repo 内业务概念命名 SoT。前后端 + DB schema 三处保持严格一致。

- 业务概念（account / note / tag / session / ...）在前后端保持**统一英文命名**
- 避免中英混用或拼音
- 业务模块字符串在多处保持严格一致：
  - 后端 NestJS module 目录：`apps/server/src/<module>/`（如 `auth/` / `account/` / `security/` / `portfolio/` / `marketdata/` / `alert/` / `chat/` / `ideation/` / `optionsdesk/` / `research/`；模块内**扁平**文件平铺,无 `domain/application/infrastructure/web` 层子目录,per [ADR-0043](../adr/0043-server-flat-module-paradigm.md) §1;bounded context 边界 per [ADR-0032](../adr/0032-backend-bounded-context.md)）
  - 前端 feature 目录：`apps/mobile/src/<feature>/`（命名与后端 module 一致；已迁入的 feature 见 `ls apps/mobile/src/`）
  - 数据库 schema：`<module>`
- **加新模块时**：上述位置必须同时落地。CI 守门两道：`eslint-plugin-boundaries` 文件级 bounded-context 边界（`apps/server/eslint.config.mjs`，per [ADR-0032](../adr/0032-backend-bounded-context.md)）+ `scripts/checks/check-server-moat.ts` 的 Prisma model 归属表（`MODEL_OWNERSHIP`，接新表必声明 owner，否则红）
