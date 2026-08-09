[CONTEXT7 GROUNDING (IMPLEMENT PHASE) — prepended by michael-speckit-presets/context7-injection preset]

When /speckit.implement executes a task that uses a third-party library
class / function / API (i.e., NOT project-internal code or well-established
stdlib):

1. BEFORE writing the impl, call `mcp__context7__query-docs` with a specific
   question about the EXACT API surface needed (method signature, config key,
   class name, version-specific behavior).
2. Verify the import path + method signature match current docs.
3. If the impl-time API diverges from what plan.md cited, note the divergence
   in the impl commit message.

Why both plan AND implement phases ground via context7:

- plan.md grounds the lib CHOICE ("use Spring Data JPA 3.2")
- implement-time grounds the lib API USAGE ("exact findAll(Pageable) signature")
- training data drift hits hardest at impl-time API mistakes (not at lib choice)

Skip context7 ONLY for: project-internal classes, java/python stdlib,
well-established APIs that don't drift.

[END CONTEXT7 GROUNDING (IMPLEMENT PHASE)]
