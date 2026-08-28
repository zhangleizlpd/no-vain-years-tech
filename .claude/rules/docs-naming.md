---
paths:
  - 'docs/private/plans/**'
  - 'docs/improvements/**'
  - 'docs/experience/**'
---

# Docs 命名纪律（path-triggered，读取 / 编辑 `docs/private/plans/**` · `docs/improvements/**` · `docs/experience/**` 已有文件时自动加载；**新建走 Write 不触发** —— 命名时刻的提醒由 `scripts/pretooluse-convention-rubric.sh` 注入）

新建文件按 `MM-DD-<kebab-slug>.md`，归档进 `YYYY-MM/` 月度子目录：

- `MM-DD`：创建当日（本地时区，零填充）
- `<kebab-slug>`：kebab-case 3-5 词，关键名词 + 动作/状态；**避免泛词**（`notes` / `misc` / `tmp` / `update`）
- 文件名总长 ≤ 60 字符；同日同 slug 撞名 → 末尾加 `-2` / `-3`
- 若当月 `YYYY-MM/` 目录不存在则创建

`docs/improvements/` 放**调优 / 优化 / 改造的实测记录**（入仓）—— convention 里不许出现的时点数字落这里。
`docs/experience/` 为 local-only（gitignored，不入库）；命名 / 目录约定仍适用于本地文件。

> 完整约定 + 约束范围（哪些目录不受此约束）+ 三类记录怎么选见 canonical `docs/conventions/docs-organization.md`。lefthook `docs-organization-drift` 只拦入仓的 `docs/improvements/` 新文件命名；plans / experience 是 gitignored、进不了 staged，靠写入时刻的 hook 提醒。
