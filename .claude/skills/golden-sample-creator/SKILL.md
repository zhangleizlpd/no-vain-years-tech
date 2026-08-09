---
name: 'golden-sample-creator'
description: '把一个刚解决的问题 / 范例代码沉淀为 golden sample，一次性落入仓内三层最佳实践体系（golden-sample-registry 索引 + impl-playbook HOW 纪律 + .claude/rules path-trigger + 代码 // GOLDEN SAMPLE banner），让后续所有 SDD impl（/sdd-auto-impl 派单 step 0 读 registry 注入子 agent brief）都能参考借鉴。触发：用户提"把这个沉淀成 golden sample / 这个可以当模板 / 这段当样板 / 落入最佳实践 / promote 样板 / 加个 golden sample / golden-sample-creator"，或解决一个有代表性问题后想把范式固化时。'
argument-hint: '[范例文件路径]（可选；省略则问 / 从最近改动推断）'
user-invocable: true
disable-model-invocation: false
---

# golden-sample-creator — 把解决方案沉淀为 golden sample

把「我刚解决了 X，这个值得当模板」从**易错的手工多处编辑**，变成**有 checklist + verify 门兜底**的流程。锁定 golden-sample 三层体系，不做泛化最佳实践。

> **为什么沉淀进 registry 就能惠及未来**：`golden-sample-registry.md` 不是死文档——`/sdd-auto-impl` 派单时（command step 0）**读它**，把"golden 参考（样板路径 + 一句学什么）"塞进干净上下文子 agent 的 brief。往 registry 正确落一条 = 自动惠及所有未来 SDD impl。这是本 skill 存在的全部意义。

## 三层体系 cheat-sheet（先认清哪层放哪）

| 层               | 文件                                                  | 装什么                                                           | 何时要                                       |
| ---------------- | ----------------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------- |
| **索引（SoT）**  | `docs/conventions/golden-sample-registry.md`          | 「task kind → 样板路径」一行 + `学什么`（含 §锚）+ `不适用/边界` | **永远要**（这是 /sdd-auto-impl 读的那张表） |
| **HOW 纪律**     | `docs/conventions/{mobile,server}-impl-playbook.md` § | 为什么这么写 / 怎么写 / 坑 + **实证锚**                          | 范式有"做法 + 反模式"要讲时                  |
| **path-trigger** | `.claude/rules/{mobile,server}-impl-playbook.md`      | 碰相关文件自动加载的一句硬提醒                                   | 这是"改 X 类文件时必须看见"的 guardrail 时   |
| **代码锚**       | 样板文件头 `// GOLDEN SAMPLE` banner                  | 一行说明 + 指回 registry / playbook §                            | **样板文件永远加**                           |

**不是每次都全四层**：纯"照抄结构"的样板 → 索引 + banner 足矣；带工程纪律/反模式的 → 加 playbook §；属"编辑某类文件必须看见的护栏" → 才加 path-rule。

## 流程（按序执行）

### 1. Intake（缺啥问啥，别瞎猜）

确认四件事，缺则问用户：

- **解决了什么问题**（一句话，将来当"学什么"的种子）。
- **范例文件**（`$ARGUMENTS` 或从最近 commit / git diff 推断；让用户点头确认这就是要立的样板）。
- **平台**：mobile 还是 server（决定进哪个 playbook / rule）。
- **先 Read 目标文件真身**：动手设计 registry 行/段前，**实际 Read** 三层目标文件当前内容（registry / 目标 playbook / 目标 rule），别凭记忆或注入 context 设计（可能 stale → 行风格/§编号对不上）。`rg` 在**目标工作树**跑（带 `git status` 自检路径）。
- **新行 or 扩展**：先 `rg` registry 看有没有沾边的现有行。判据见 step 2（同主题新实例 → 扩展，别新开行）。

### 2. Classify（定落哪几层）

**先定 新行 vs 扩展**（B/C 实测真空，否则易错立重复行）：`rg` 命中沾边行 → 它是不是**同一「学什么」主题轴的新实例**（机制不同但解决同一类问题，如「列表数据新鲜度」下的"写路径失效" vs "焦点重取"）？

- **是** → **并入**：扩现有行 / 拓宽「学什么」/ 加进复用清单（如 `~/ui` 原语清单），**不新开表行**。
- 仅当**机制 + 样板文件 + §锚 三者皆独立** → 才**新立一行**。

再按 cheat-sheet 判这次要写的层。**默认**：索引（行 or 并入）+ banner。逐项自问：

- 有"做法 + 为什么 + 反模式"要讲 → +playbook §（纯"照抄结构"无纪律 → **不加**，别为完整硬塞）。
- 是"编辑某类文件时必须被提醒"的护栏 → +path-rule 一行。

> 🚩 **intake 红线**：用户若要求往 playbook **加任何「表 / 清单 / 聚合索引」** → 默认**拒**，改"链回 registry"（registry 是唯一索引，复制即反模式①）。把防御前移到动手前，别等 verify 门事后抓。

### 3. Apply（按定的层写入）

- **registry 行**（必）：`| <task kind> | <样板路径> | <学什么>；纪律 → <playbook §X> | <不适用/边界> |`。`学什么` 写"照抄什么结构/范式"，不写业务。§锚用**节号** `§ N`（匹配 registry 既有风格，**非 slug**）。
- **playbook §**（按需）：在对应 playbook 加节或扩节。含 `实证锚`。
  - 🚨 **反面教训只在有实证时写**（e2e 红 / 实测数据 / git 史），且写明实证来源。没跑过别下"这样做会坏"的结论（本 skill 诞生就因一次把 flaky 误判成"turn 失效破 e2e"的假反面教训）。
  - 🚨 **用户主动递来的反面教训**：写入前**必须独立核验其前提**（`rg` / `git log` / 相关 PR body 三查），证伪即拒——别因"用户这么说"就照写（污染会经 /sdd-auto-impl brief 扩散）。
- **path-rule 一行**（按需）：在 `.claude/rules/{mobile,server}-impl-playbook.md` 加一句，末尾 `详版见详版 § X`。
- **代码 banner**（必）：样板文件头加 `// GOLDEN SAMPLE — <一句>。索引见 docs/conventions/golden-sample-registry.md，详版见 <playbook § X>。`

### 4. Wire（双向锚定，别留孤儿）

- registry 必须**被链接到**（playbook/rule 里有指向 registry 的链接）——否则编辑流够不到它，成"幽灵索引"。新建 registry 行不需重复链接（registry 文件已被链），但若动了 playbook/rule，确认链接还在。
- registry 行的 §锚（`纪律 → playbook § X`）必须**指向真实存在的段标题**。
- 反向：playbook 该节可点名样板文件（就地点名 + 指回 registry），但**不要把 registry 那张索引表复制进 playbook**（三处 drift 之源）。

### 5. Verify 门（机械跑，治本 skill 诞生那次踩的坑）

全过才算沉淀完成：

1. `npx markdownlint-cli2 <改动的 .md ...>` → `0 error`。
2. `rg -l "golden-sample-registry" docs/conventions/ .claude/rules/` → registry 仍被链接（≥ 原数，别把链接改丢）。
3. §锚解析：registry 行里写的每个 `§ X`，在目标 playbook 用 `rg "^#{1,3}.*X"` 验真实存在（**别过度承诺"已注 §锚"——没注就别在分工说明里声称注了**）。
4. 无重复表：确认没往 playbook 新增一张镜像 registry 的聚合样板表。
5. banner 在：`rg "GOLDEN SAMPLE" <样板文件>` 命中。

### 6. 反模式 checklist（提交前自查，全是本仓真实踩过的坑）

- ❌ 把 registry 索引表**复制**进 playbook（→ 三处 drift）。改"就地点名 + 链回 registry"。
- ❌ §锚**过度承诺**（分工说明称"关键行已注 §锚"但 server 行没注）→ 要么补真锚、要么改措辞。
- ❌ 没实证就写**反面教训**（"这样做会坏"）→ 必须附 e2e/实测/git 史来源。
- ❌ 索引（WHAT/WHERE）和纪律（HOW/WHY）**混层**：registry 写一堆 how、playbook 重复一张索引表。各守其职。
- ❌ registry 改完没跑 markdownlint / 没验 §锚解析就收工。

## 收尾

- 把改动按 [git-workflow](../../../docs/conventions/git-workflow.md) 走（docs/config 改动 → `docs(conventions):` 或 `chore:`）；样板代码本身的 banner 若和功能改动同 PR 则随该 PR。
- 一句话回报：立了哪个 task-kind、落了哪几层、verify 门结果。

## 引用（不复述）

- 三层体系活实例：本 skill 的设计源自 `golden-sample-registry.md` 收敛 + §8 React Query 缓存失效纪律的沉淀（2026-06-25）。
- 建 / 改 `.claude/` 规矩 → [`docs/conventions/claude-config-layout.md`](../../../docs/conventions/claude-config-layout.md)（团队共享、进 git）。
- /sdd-auto-impl 读 registry 的集成点 → `.claude/commands/sdd-auto-impl.md` step 0「golden 参考」。
