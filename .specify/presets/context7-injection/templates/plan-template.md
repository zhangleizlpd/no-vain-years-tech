[CONTEXT7 GROUNDING (PLAN PHASE) — prepended by michael-speckit-presets/context7-injection preset]

Before drafting any technical decision in plan.md that involves a third-party
library (Maven/Gradle dep, Spring module, npm package, Python package, CLI
tool, cloud SDK):

1. Call `mcp__context7__resolve-library-id` with the official library name.
2. Call `mcp__context7__query-docs` with a SPECIFIC question (API signature,
   config key, version-pinned behavior). Bad: "Spring Data JPA". Good:
   "Spring Data JPA 3.2 Specification + Pageable findAll signature".
3. Cite the resolved library version in plan.md (e.g., "verified against
   /spring-projects/spring-data-jpa/v3.2.0 via context7").

Skip context7 ONLY for: well-established stdlib APIs (java.util.*), pure
business logic, project-internal code.

[END CONTEXT7 GROUNDING (PLAN PHASE)]
