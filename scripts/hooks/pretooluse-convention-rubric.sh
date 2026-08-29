#!/usr/bin/env bash
# PreToolUse(Write|Edit) hook — convention durability rubric (non-blocking).
#
# 写 docs/conventions/*.md 时注入「耐久性自检」；写 docs/private/plans / docs/improvements /
# docs/experience 下的 .md 时注入「命名闸」（Write 新文件不触发 path rule，这里是唯一的命名时刻通道）；
# **Write（仅新建时刻）** specs/ 下的 .md 时注入「SDD 产物闸」—— sdd-authoring.md 那条
# path rule 在新 feature 首次建 spec/plan 时恰好不触发，而那正是 upstream speckit SKILL
# 字面大纲最容易带偏的时刻（038 于 2026-07-11、067 于 2026-08-29 两次实撞：多造
# research.md / data-model.md / quickstart.md）。Edit 蓄意不注入：path rule 已覆盖
# edit/read，且 /implement 期 tasks.md 的每次 [X] flip 都是 Edit，注入会逐 task 刷屏。
# 其余路径零输出。
# NEVER blocks（fail-open 契约同 pretooluse-local-verify-guard.sh：任何解析失败一律放行）。
#
# 为什么是 hook 而不是（只有）path rule：装载日志实证（2026-08-03，n=1 + 机制自洽）
# path rule 在 Read 命中文件时注入、Write 新文件不触发 —— 而 testing.md（#823）/
# test-environment-matrix.md（#803）两次「状态数字进 convention」事故恰恰都是 Write
# 新文件。hook 是唯一覆盖「新建 convention」时刻的通道；.claude/rules/
# convention-authoring.md 覆盖 edit/read 路径，两者互补不冗余。
#
# 形态先例：~/.claude/hooks/memory-placement-rubric.sh（同 schema，2026-06-18 验证：
# PreToolUse 支持 {"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":...}}
# + exit 0 = 注入且放行）。

input=$(cat) || exit 0

fp=$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null) || fp=""
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null) || tool=""

# docs/conventions/ 顶层 .md（该目录蓄意扁平）→ 耐久性闸；三类记录目录 → 命名闸；
# specs/ 下 .md 且 tool=Write（新建时刻）→ SDD 产物闸；其余零输出
case "$fp" in
  */docs/conventions/*.md) MODE=durability ;;
  */docs/private/plans/*.md|*/docs/improvements/*.md|*/docs/experience/*.md) MODE=naming ;;
  */specs/*.md)
    [ "$tool" = "Write" ] || exit 0
    MODE=sdd
    ;;
  *) exit 0 ;;
esac

NAMING='🚨 DOCS 命名闸 — 你正在写 plans / improvements / experience：文件名 MM-DD-<kebab-slug>.md（创建当日零填充；kebab 3-5 词，关键名词 + 动作/状态；避免 notes / misc / tmp / update 泛词；总长 ≤ 60 字符；同日撞名加 -2/-3），归 YYYY-MM/ 月度子目录（evidence 按 feature 目录）。convention 里不许出现的时点数字落 improvements。完整约定：docs/conventions/docs-organization.md。'

RUBRIC='🚨 CONVENTION 耐久性闸 — 你正在写 docs/conventions/（evergreen-only 区）。本次写入完成后，MUST 逐行复扫这次 diff，对每条事实性陈述问：「repo 再长 12 个月，这行还成立吗？」
• NEVER 写时点事实：文件计数 / 耗时 / 百分比 / 进度台账 / 「已修复 / 尚未 / 当前还剩 N 个」状态叙述 —— 随代码增长必然失效。归宿：实测数据 → docs/improvements/YYYY-MM/；执行状态 → docs/private/plans/。
• 耐久锚 OK：PR # 与日期作历史证据锚（「2026-08-01 045 实证」永真）、外部常数（Google 80/15/5 配比）、判据 / 规则表 / 复跑命令。
• 判据不是「有没有数字」，是「会不会随时间失效」。
• 新建 convention 文件？MUST 让它可达：CLAUDE.md 按需表加行，或 .claude/rules / 兄弟 convention 指过来（check-convention-orphan.ts 机器守，全仓零引用 = 红）。
• 任何一行过不了 12 个月测试 → 现在就挪走（再 Edit 一次），不要留给 review。完整约定：docs/conventions/docs-organization.md。'

SDD='🚨 SDD 产物闸 — 你正在 specs/ 下新建 .md。产物集白名单 = spec.md / plan.md / tasks.md / analysis.md / checklists/*（design/ local-only）。
• NEVER 生成 research.md / data-model.md / quickstart.md / contracts/ —— upstream speckit SKILL 的字面大纲会明确叫你生成它们，抵住：本仓 preset 已把 Phase-0 折进 plan.md 的「Research Gates」段，plan 是 PROSE-ONLY 单文件（data model SoT=schema.prisma / API SoT=swagger 装饰器，镜像必 drift）。唯一例外：真实外部调研（vendor 选型类）可建 research.md（先例仅 035/036/037）。
• 动笔前 MUST ls 近 2-3 个 specs/NNN-*/ 对照产物集与格式；tasks 层级 tag 词汇表以既有 tasks.md 为准。
• 完整细则：.claude/rules/sdd-authoring.md § 反模式 + docs/conventions/sdd.md。'

[ "$MODE" = naming ] && RUBRIC="$NAMING"
[ "$MODE" = sdd ] && RUBRIC="$SDD"
jq -n --arg ctx "$RUBRIC" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}' 2>/dev/null || exit 0
exit 0
