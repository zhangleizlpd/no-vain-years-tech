---
adr_id: ADR-0029
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - NestJS 出 bundler-friendly build target (无需 nodenext + .js 后缀)
  - TS 出 universal resolution mode (覆盖 Node ESM + Metro + Vite 三栈)
  - apps/server 切 Bun runtime (per [ADR-0018](0018-backend-language-pivot.md) sunset path) — Bun 不需要 `.js` 后缀
---

# ADR-0029: TS Module Resolution Policy — base = `bundler`, apps/server override = `nodenext`

- Status: Accepted (2026-05-21) — shipped via PR-2 (tsconfig swap)
- Deciders: project owner
- Tags: build / typescript / cross-cutting

## Context

A-002 ship (PR #65/#66/#67) 暴露 `tsconfig.base.json` 用 `moduleResolution: nodenext` + `module: nodenext` 与前端生态对抗:

| 工具            | 期望 resolution              | 与 nodenext 冲突                                |
| --------------- | ---------------------------- | ----------------------------------------------- |
| Vite (Web)      | `bundler` (no extension)     | `.js` 后缀 import 在 .ts source 编辑期 IDE 报错 |
| Metro (Expo)    | implicit relative            | `.js` 后缀解析失败 (`.ts` source 找不到)        |
| Webpack         | `bundler` 或自定义           | 同 Vite                                         |
| **Node.js ESM** | `nodenext` (强制 `.js` 后缀) | 唯一真需要的栈                                  |

**packages/api-client** (前轮 PR #67 包内加 bundler override 半补) + **packages/auth** (`.js` 后缀强加被 PR #67 sweep) 实证 nodenext 是 mono 默认 wrong 选择。

仅 **apps/server** (NestJS + Node.js runtime) 真需要 nodenext (Node.js ESM 加载强制 explicit `.js`)。

## Decision

### tsconfig.base.json (mono root)

```jsonc
{
  "compilerOptions": {
    "moduleResolution": "bundler",
    "module": "esnext",
    // ... 其余不变
  },
}
```

### apps/server/tsconfig.json (sole override)

```jsonc
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "moduleResolution": "nodenext",
    "module": "nodenext",
  },
}
```

### apps/mobile / packages/\* — 继承 base (`bundler` / `esnext`),不 override

### PR-2 切换步骤

1. 改 `tsconfig.base.json` 两字段
2. 加 `apps/server/tsconfig.json` override
3. 删 PR #67 在 `packages/auth/tsconfig.json` 加的 bundler override (现继承自 base)
4. `pnpm nx run-many --target=typecheck --all --skip-nx-cache` GREEN
5. `pnpm nx run mobile:build` GREEN (无 `.js` 后缀解析报错)

## Consequences

- **apps/server import 仍需 `.js` 后缀**(Node.js ESM 硬规则) — 不影响 dev 体验,IDE auto-import 配 nodenext 即自动加
- **apps/mobile / packages/\* import 写 `import x from './y'`**(无后缀) — 与 Vite/Metro/RN 社区一致
- **dist 输出** server 走 nodenext (`.js` 后缀),mobile 走 esnext (bundler 处理) — 物理隔离,无 cross-contamination

## Trade-offs

- server 与 mobile/packages 两套 import 风格 — 但物理边界清晰(`apps/server/**` vs 其余),AI agent 易识别
- nodenext-only override 在 server,未来切 Bun 可一次性删 override (Bun 不要求 `.js` 后缀)

## References

- memory `reference_pnpm_C_does_not_propagate_child_cwd` (相关 build tool cwd 不一致问题)
- PR #67 (`shamefully-hoist` ship 同时 sweep packages/auth `.js` 后缀)
- <https://www.typescriptlang.org/docs/handbook/modules/reference.html#bundler>
- [AI Friction Catalog · F-001 TS-Bundler-Mismatch](../conventions/ai-friction-catalog.md#f-001--ts-bundler-mismatch) — 本 ADR 是此 friction 的直接缓解
