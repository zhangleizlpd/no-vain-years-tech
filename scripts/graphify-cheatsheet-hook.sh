#!/usr/bin/env bash
# SessionStart hook — inject the graphify code-graph cheat-sheet so the agent
# routes structure / relationship / impact questions to the MCP tools instead
# of grep. Gated on the graph existing; stays silent otherwise.
#
# Self-locates the repo root from the script path (NOT cwd) so it survives
# /clear, which resets cwd to $HOME in current Claude Code.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$ROOT/graphify-out/graph.json" ] || exit 0   # no graph → stay silent

cat <<'EOF'
📊 Code knowledge graph is available at graphify-out/graph.json (kept fresh by git hooks).
For codebase STRUCTURE / RELATIONSHIP / IMPACT questions, prefer the graphify MCP tools
over grep / Glob / Read-scanning — they return a scoped subgraph, not raw file dumps:

  • "where is X defined" / "what is X"            → mcp__graphify__get_node {label}
  • "who calls X" / "what does X depend on"        → mcp__graphify__get_neighbors {label}
  • "path / call-chain from A to B"                → mcp__graphify__shortest_path {source,target}
  • open-ended "how does <feature> work"           → mcp__graphify__query_graph {question}
  • "core abstractions / where do I start"         → mcp__graphify__god_nodes
  • "what breaks if I merge PR #N" (blast radius)  → mcp__graphify__get_pr_impact {pr_number}
  • "which PRs should I review / merge first"      → mcp__graphify__triage_prs

Keep using grep / Glob for: literal strings inside function bodies, config / JSON / log
values, single-file text search. Rule of thumb: single-hop text → grep; multi-hop
relationship, "who calls", or change blast-radius → graph. For a deliberate pre-refactor
or PR-review impact check, run /graphify-impact.
EOF
