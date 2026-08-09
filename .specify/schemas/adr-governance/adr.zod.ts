/**
 * ADR frontmatter Zod schema — adr-governance preset 0.1.0.
 *
 * Loaded by scripts/check-adr-frontmatters.ts.
 *
 * Layout when installed into mono:
 *   <repo>/.specify/schemas/adr-governance/adr.zod.ts  ← this file
 *
 * 4 mandatory fields:
 *   adr_id          ADR-NNNN, NNNN 4-digit (file naming convention)
 *   status          Proposed | Accepted | Deprecated | Superseded | Reserved
 *   applies_to      list of scopes (apps/<name>, packages/<name>, security,
 *                   infrastructure, mono-wide)
 *   sunset_trigger  multiline string, ≥ 10 chars (force explicit thinking)
 *
 * Extra fields allowed (frontmatter is open by default).
 */
import { z } from "zod";

export const AdrStatusEnum = z.enum([
  "Proposed",
  "Accepted",
  "Deprecated",
  "Superseded",
  "Reserved",
]);

const ScopePattern =
  /^(mono-wide|infrastructure|security|apps\/[a-z0-9-]+|packages\/[a-z0-9-]+)$/;

export const AdrFrontmatterSchema = z.object({
  adr_id: z
    .string()
    .regex(/^ADR-\d{4}$/, "adr_id must match /^ADR-\\d{4}$/ (e.g. ADR-0042)"),
  status: AdrStatusEnum,
  applies_to: z
    .array(
      z
        .string()
        .min(1)
        .regex(
          ScopePattern,
          "scope must be one of: mono-wide | infrastructure | security | apps/<name> | packages/<name>",
        ),
    )
    .min(1, "applies_to must contain at least 1 scope"),
  sunset_trigger: z
    .string()
    .min(
      10,
      "sunset_trigger must be ≥ 10 chars — force explicit thinking on when this ADR should be re-reviewed",
    ),
});

export type AdrFrontmatter = z.infer<typeof AdrFrontmatterSchema>;
