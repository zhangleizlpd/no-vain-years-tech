// Conventional Commits enforcement (mono).
// Mirror of meta-repo no-vain-years/commitlint.config.mjs to keep
// behavior aligned across repos. Used by both CI
// (wagoid/commitlint-github-action) and local lefthook commit-msg hook.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [0],
    'header-max-length': [2, 'always', 100],
    'body-max-line-length': [2, 'always', 150],
    // Align footer to body limit. Default 100 catches body lines when commit
    // contains a trailer (e.g. Co-Authored-By:) — commitlint footer algorithm
    // pulls trailing body content into footer scope. server PR #191 实证
    // 2026-05-15 (meta repo experience inherited verbatim).
    'footer-max-line-length': [2, 'always', 150],
    'subject-case': [0],
  },
};
