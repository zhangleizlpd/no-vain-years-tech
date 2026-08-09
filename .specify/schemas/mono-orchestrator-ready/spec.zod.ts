/**
 * spec.md frontmatter Zod schema — mono-orchestrator-ready 0.3.0.
 *
 * Loaded by:
 *   - scripts/check-spec-frontmatters.ts (CI + manual)
 *   - lefthook spec-frontmatter-check (pre-commit, staged specs/**\/spec.md)
 *
 * v2 invariants:
 *   - web_compat in {stub, untested} → web_compat_notes required (≥ 10 chars)
 *   - agent_friction_observed === true → agent_friction_notes required (≥ 10 chars)
 *
 * 0.2.2 增量 (PR-T1 / ADR-0040): state_branches optional 字段引入.
 * 0.3.0 增量 (PR-T3 / ADR-0040 门禁层): state_branches optional → required
 *   (.min(1)). 同 PR 内 backfill specs/001 + specs/002.
 *
 * Date fields (created_at / updated_at) accept ISO YYYY-MM-DD string OR
 * Date object (gray-matter auto-parses unquoted YAML dates per memory
 * `feedback_yaml_dates_auto_date_in_gray_matter`).
 */
import { z } from "zod";

const DateLike = z.preprocess(
  (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expect YYYY-MM-DD"),
);

const WebCompatEnum = z.enum(["full", "stub", "untested", "na"]);

const PerfBudgetSchema = z.object({
  endpoint: z.string().min(1),
  p95_ms: z.number().positive(),
  p99_ms: z.number().positive(),
  timing_defense: z
    .object({
      diff_p95_ms: z.number().positive(),
    })
    .optional(),
});

export const SpecFrontmatterSchema = z
  .object({
    feature_id: z.string().regex(/^\d{3,4}-[a-z0-9-]+$/, "feature_id must be NNN-slug"),
    modules: z.array(z.string().min(1)).min(1),
    owners: z.array(z.string().regex(/^@[\w-]+$/)).min(1),
    status: z.enum([
      "draft",
      "clarified",
      "planned",
      "tasks-ready",
      "implementing",
      "implemented",
      "superseded",
      "archived",
    ]),
    created_at: DateLike,
    updated_at: DateLike,
    spec_kit_version: z.string().min(1),
    orchestrator_compat: z.string().min(1),

    // v2 fields (0.2.0)
    web_compat: WebCompatEnum,
    web_compat_notes: z.string().min(10).optional(),
    agent_friction_observed: z.boolean(),
    agent_friction_notes: z.string().min(10).optional(),
    perf_budgets: z.array(PerfBudgetSchema).optional(),

    // 0.3.0 — state_branches: 状态机分支穷举 (per ADR-0040 multi-layer test
    // gate). Free-form string array, each entry describes one branch of the
    // truth table the feature must exhaustively cover in integration tests.
    // 0.2.2 optional → 0.3.0 required (.min(1)): every new spec MUST list
    // ≥ 1 state branch. Catches PR-79 Pattern D (漏 cold-boot 分支) at
    // /speckit-specify time.
    state_branches: z.array(z.string().min(1)).min(1),

    // contracts (optional, owned by mono-orchestrator-ready 0.1.0)
    contracts: z
      .array(
        z.object({
          path: z.string().min(1),
          checksum: z.string().min(1),
        }),
      )
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (
      (data.web_compat === "stub" || data.web_compat === "untested") &&
      !data.web_compat_notes
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["web_compat_notes"],
        message: `web_compat='${data.web_compat}' requires web_compat_notes (≥ 10 chars)`,
      });
    }
    if (data.agent_friction_observed && !data.agent_friction_notes) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["agent_friction_notes"],
        message: "agent_friction_observed=true requires agent_friction_notes (≥ 10 chars)",
      });
    }
  });

export type SpecFrontmatter = z.infer<typeof SpecFrontmatterSchema>;
