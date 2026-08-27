---
paths:
  - 'docs/conventions/**'
---

# Convention 撰写纪律（path-triggered，触及 `docs/conventions/**` 自动加载）

`docs/conventions/` 是 **evergreen-only 区**：只放一年后仍成立的常驻规则（判据 / 命名 / 决策流 / 不变量 / 举例）。

- **时点事实 NEVER 进 convention**：文件计数 / 耗时 / 百分比 / 进度台账 / 「已修复 / 尚未 / 当前还剩 N 个」状态叙述 —— 随代码增长必然失效。归宿：实测数据 → `docs/improvements/YYYY-MM/`；执行状态 → `docs/private/plans/`。
- **判据不是「有没有数字」，是「会不会随时间失效」**：PR # 与日期作历史证据锚（「2026-08-01 045 实证」永真）、外部常数（Google 80/15/5 配比）、规则表、复跑命令 —— 都是耐久的，合法。
- **新建 convention 必须可达**：CLAUDE.md 按需表加行，或 `.claude/rules/` / 兄弟 convention 指过来。全仓零引用 = 路由不到 = 等于不存在，`scripts/checks/check-convention-orphan.ts` 机器守。
- **重构 / 优化 session 的产出顺序**：先落 `docs/improvements/` 实测记录，convention 事后从记录**提炼** —— 同一 session 手边全是「修了几个 / 还剩几秒」的素材时同步写 convention，状态数字必然互渗。
- **往 CLAUDE.md 按需表加行时**：摘要 ≤ 40 字 —— 触发列才是命中依据，摘要只帮判「要不要读」；always-load 预算 5,000 tok，摘要通胀是超标主因。
- 交付前自审**逐行问「12 个月后还成立吗」**，过不了就挪走 —— 通读式自审对自己刚写的文档无效（同 SDD 反模式「analyze 靠通读」条）。

> canonical：[`docs/conventions/docs-organization.md`](../../docs/conventions/docs-organization.md)（约束范围 + 三类记录怎么选）。写入时刻的自检注入由 `scripts/pretooluse-convention-rubric.sh` 承担（本 rule 只覆盖 read/edit 路径；Write 新文件不触发 path rule，2026-08-03 装载日志实证）。
