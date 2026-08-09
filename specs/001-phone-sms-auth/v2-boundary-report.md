# V2 验收报告 — boundary lint

**T040 deliverable**：验证 `pnpm nx run server:lint` 0 violation + `eslint-plugin-boundaries` 4 类规则各写 1 个 forbidden import 验证 lint err。

**日期**：2026-05-17

## V2 PASS

- `pnpm nx run server:lint` → 0 violations / 0 warnings（已 fix v6 plugin migration drift，详见下方）
- 4 类 forbidden import 均触发 `boundaries/dependencies` error

## 配置迁移（W2 polish 阶段 surface）

V2 验收 surface 一个 Constitution IV gate 隐藏 breach：W1.4 设置时用的是 `eslint-plugin-boundaries` v5 legacy 语法（`boundaries/element-types` + 字符串 `disallow` 数组），但 plugin 实际版本是 v6（^6.0.2）。v6 在 legacy 语法下**仅 print deprecation warning 但 silently no-op**，导致 boundary 规则全程不 enforce。

### 迁移 3 步（本 PR 同 commit 落地）

1. 装 `eslint-import-resolver-typescript`（plugin v6 需 explicit resolver 才能将 `../application/...` 类相对路径 map 到 element type）
2. `apps/server/eslint.config.mjs`：
   - `boundaries/element-types` → `boundaries/dependencies` 重命名
   - rule body 改 object selector：`{ from: { type: 'X' }, disallow: { to: { type: ['Y', 'Z'] } } }`
   - settings 加 `'import/resolver': { typescript: { alwaysTryTypes: true, project: './tsconfig.json' } }`
3. spec override section 也同步：`'boundaries/element-types': 'off'` → `'boundaries/dependencies': 'off'`

## 4 类规则 forbidden import 验证

测试方法：在 from 层临时建 `tmp-v-<scenario>.ts` 文件 import to 层 → `pnpm exec eslint <files>` → 抓 err msg → 删 tmp 文件。

| #   | from → to                   | 文件                           | err msg                                                                                                                     |
| --- | --------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | `domain` → `application`    | `src/auth/domain/tmp-v-d2a.ts` | `Dependencies to elements of type "application" are not allowed in elements of type "domain". Denied by rule at index 0`    |
| 2   | `domain` → `infrastructure` | `src/auth/domain/tmp-v-d2i.ts` | `Dependencies to elements of type "infrastructure" are not allowed in elements of type "domain". Denied by rule at index 0` |
| 3   | `domain` → `web`            | `src/auth/domain/tmp-v-d2w.ts` | `Dependencies to elements of type "web" are not allowed in elements of type "domain". Denied by rule at index 0`            |
| 4   | `web` → `infrastructure`    | `src/auth/web/tmp-v-w2i.ts`    | `Dependencies to elements of type "infrastructure" are not allowed in elements of type "web". Denied by rule at index 1`    |

全 4 例返 `exit 1`，`boundaries/dependencies` rule level=error → CI lint job 会拦。

## 当前覆盖范围

| 规则                                                 | 状态        | 备注                                                                                                        |
| ---------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------- |
| domain ↛ application / infrastructure / web / module | ✅ enforced | rule index 0                                                                                                |
| web ↛ infrastructure（必经 application）             | ✅ enforced | rule index 1                                                                                                |
| 跨 module 经 module exports                          | 🔜 defer    | mono W2 仅 1 个 module（auth），多 module 后启用 `boundaries/dependencies` 加 captured module name selector |
| shared packages ↛ apps/\*                            | 🔜 defer    | mono W2 仅 `apps/server`，多 `packages/*` 后启用 origin selector                                            |

## 反退化护栏

- `boundaries/dependencies` 在 `eslint.config.mjs` rule level = `'error'`（不是 'warn'）→ CI lint job 一遇 violation 立刻红
- CI `Lint (nx lint server)` job 已加进 mono main-protection ruleset required_status_checks（T042 同 PR 落地）

## 后续 W3+ work

- mono 引入多 module / 多 packages 后，amend `eslint.config.mjs` 加 rule 3/4
- 评估迁出 `default: 'allow'` → `default: 'disallow'` 更严格的 hexagonal 边界（mono 当前 lint pass 是因 default allow，所有未明示 disallow 的关系默认放行）
