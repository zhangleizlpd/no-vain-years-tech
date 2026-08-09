---
adr_id: ADR-0031
status: Accepted
applies_to: [mono-wide]
sunset_trigger: |
  - ADR 总数 < 15 (governance overhead > benefit)
  - 切其他决策记录工具 (Architecture Haiku / decision-log 等)
  - LLM agent 演化到能自动 navigate ADR 库无需 programmatic filter
---

# ADR-0031: ADR Governance — frontmatter 强制 + Zod schema + programmatic filtering

- Status: Accepted
- Deciders: project owner
- Tags: repo / governance / adr / cross-cutting

## Context

Plan 1-2 累积 ADR 0018-0025 后,实际使用中暴露 2 类问题:

### 问题 1: scope 误读

[ADR-0018](0018-backend-language-pivot.md) 描述"NestJS + Fastify + Prisma + Nx + SWC bundle"被 LLM agent 误读为 mono-wide(实际仅 `apps/server`),导致 apps/mobile task LLM 也加载 ADR-0018 上下文,浪费 token + 偏离决策。

类似 [ADR-0024](0024-spec-feature-first-layout.md) 是 mono-wide(SDD 工具) — 错把它过滤掉会让 spec-kit 相关任务失去关键约束。

### 问题 2: ADR 生命周期不可机器判定

- 哪些 ADR 该 Deprecate? 无 `sunset_trigger` 字段,人脑判断不可扩展
- PR review 时无法 lefthook 拦截"提案缺必填字段"

## Decision

### Frontmatter 强制 4 字段

每个 ADR 文件顶部必须含 YAML frontmatter:

```yaml
---
adr_id: ADR-<NNNN> # 与文件名 NNNN 一致
status: Proposed | Accepted | Deprecated | Superseded | Reserved
applies_to: [<scope>, ...] # 路径段或 'mono-wide';见 schema
sunset_trigger: | # multiline string,列触发本 ADR 重审的具体条件
  - 触发条件 1
  - 触发条件 2
---
```

**applies_to 取值域**:

| 值                | 含义                   |
| ----------------- | ---------------------- |
| `apps/server`     | 仅后端                 |
| `apps/mobile`     | 仅前端 (含 Web export) |
| `packages/<name>` | 特定 package           |
| `infrastructure`  | 部署 / CI / 运维相关   |
| `security`        | 安全 / 合规相关        |
| `mono-wide`       | 全仓适用               |

可组合 list (e.g. `[apps/server, packages/types]`)。

### Zod schema 校验 (`.specify/schemas/adr-governance/adr.zod.ts`)

```ts
import { z } from 'zod';

export const AdrFrontmatterSchema = z.object({
  adr_id: z.string().regex(/^ADR-\d{4}$/),
  status: z.enum(['Proposed', 'Accepted', 'Deprecated', 'Superseded', 'Reserved']),
  applies_to: z.array(z.string().min(1)).min(1),
  sunset_trigger: z.string().min(10),
});
```

### Lefthook hard gate

`lefthook.yml` `pre-commit` 加 `adr-frontmatter-check`:扫 staged `docs/adr/*.md`,gray-matter 解 frontmatter,对每个 file 跑 Zod schema → fail 拒 commit。

### ADR 修订策略（分层不可变）

ADR 是否可 in-place 改、还是必须 supersede 立新篇，按 `status` 分层（不是「一律不可变」的一刀切）。理由：当前整套 ADR 是 **pre-1.0 未冻结基线**（含 anchor / 包名 / 类名待纠正的 stale 正文），对其行「不可变」仪式只会把纠错成本无意义放大。

| status                       | 修订规则                                                                                                                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `Proposed`                   | 尚未冻结 — 自由 in-place 改 / 删，无需 supersede。                                                                                             |
| `Accepted`                   | 默认 **supersede-not-delete**：**决策本身**变更时立新 ADR、旧篇标 `Superseded` 并链接覆盖，留住「代码为何长这样」的 rationale。                |
| `Accepted`（非决策变更豁免） | 「不改变决策」的修订 **允许 in-place 改**：anchor typo / 版本号更新 / 路径名更正 / 笔误纠正 / README 索引同步。判据 = 改后决策结论是否仍等价。 |
| `Deprecated` / `Superseded`  | 终态留史 — 不再 in-place 改。                                                                                                                  |

`docs/adr/README.md` L3 的修订声明是本规则的面向读者摘要，二者保持一致。

### Orchestrator programmatic filter

未来 orchestrator (LLM agent 自动 loop) 按 task scope 加载 ADR:

```ts
// pseudo: 给 apps/mobile task 加载哪些 ADR?
loadADRsFor(taskScope: string): ADR[] {
  return allADRs.filter(adr =>
    adr.status === "Accepted" &&
    (adr.applies_to.includes(taskScope) || adr.applies_to.includes("mono-wide"))
  );
}
```

## Consequences

- **现有 7 ADR 必须 backfill 4 字段**(PR-1 C1 完成)
- **新 ADR 模板** (`.specify/templates/adr-template.md`) 强制 4 字段
- **lefthook 拒非法 frontmatter**:`adr_id` 不匹配文件名 / `status` 非枚举 / `applies_to` 空 / `sunset_trigger` < 10 字符 都拒
- **orchestrator filter 可用后**:LLM agent 上下文窗口节省 (per task 加载 ~30% ADR 而非全部)

## Trade-offs

- `sunset_trigger` 写出来的成本(每个 ADR 加 3-5 行思考)— 一次性投入,长期 governance 收益
- 未来 ADR 数 < 15 时 governance 收效弱 — sunset trigger 1 路径

## References

- memory `feedback_audit_must_verify_code_anchors` (governance 校验思路源头)
- [ADR-0024](0024-spec-feature-first-layout.md) (类似 frontmatter 反查思路)
- [AI Friction Catalog · F-006 Indirect-Spec-Module-Mapping](../conventions/ai-friction-catalog.md#f-006--indirect-spec-module-mapping) — ADR `applies_to` + programmatic filter 缓解 LLM 上下文噪声
