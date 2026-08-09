---
description: Blast-radius / PR-impact analysis via the code graph (graphify MCP). User-invoked gate to run before a refactor or PR review.
disable-model-invocation: true
allowed-tools: mcp__graphify__get_pr_impact, mcp__graphify__triage_prs, mcp__graphify__list_prs, mcp__graphify__shortest_path, mcp__graphify__get_neighbors, mcp__graphify__get_node, mcp__graphify__query_graph
---

Run a code-graph impact analysis. This command is the deliberate checkpoint where the
graph beats grep: multi-hop blast radius and PR overlap. Argument: `$ARGUMENTS`.

## Dispatch on the argument

1. **Empty / "review" / "prs"** → call `mcp__graphify__triage_prs`. Report, per PR:
   number, title, affected communities, blast radius (nodes touched), and a suggested
   review / merge order with conflict-risk flags. Answers "what should I review / merge?".

2. **A PR number** (e.g. `123` or `#123`) → call `mcp__graphify__get_pr_impact` with that
   `pr_number`. Report which files it changes, which graph communities it hits, node count
   touched, and overlap with any other open PR (cross-check `triage_prs` if useful).
   Conclude with a merge-risk verdict (low / medium / high) and the reason.

3. **A symbol or file label** (anything else, e.g. `AuthService` or `apps/server/src/auth`)
   → assess refactor blast radius:
   - `mcp__graphify__get_node` with the label to confirm the node exists (disambiguate if
     the match is fuzzy — show candidates, don't guess).
   - `mcp__graphify__get_neighbors` for direct callers / dependents.
   - For each high-value dependent, `mcp__graphify__shortest_path` to trace how far the
     change propagates.
     Report the impacted set as a tiered list (direct → transitive) and the modules crossed.

## Rules

- This is a **read-only analysis** command — do NOT edit code. Output a report only.
- If the requested node / PR is not found, say so plainly and suggest the closest matches
  (`query_graph` with the term) rather than guessing.
- Prefer graph tools over grep here by construction; only fall back to grep for literal
  text the AST graph does not index (string contents, config values).
