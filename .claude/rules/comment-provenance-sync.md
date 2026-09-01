---
paths:
  - 'apps/server/src/marketdata/**'
  - 'apps/server/src/optionsdesk/**'
  - 'docs/adr/**'
---

# 注释出处（path-triggered，改 marketdata / optionsdesk / ADR 自动加载）

**写下任何「vendor / 交易所 / 第三方平台**运行时行为**会怎样」的句子之前**，先过这道。
不管本仓自己的代码在做什么（那从相邻代码即可证否）。

- **能指出出处吗？** 能 → 写，带 `EVIDENCE:`。不能 → ① 去查证 → ② **不写（默认）** → ③ 非写不可才 `ASSUMED:`。
- **为什么默认不写**：外部实证——**错注释实质降低下游模型表现，缺失注释影响轻微**；且下游
  **摆脱不掉**误导注释（明确指示它忽略也没用）。⇒ 无出处的断言会主动把下一个读者带偏，代价高于空着。
- **观测值本身就是合法出处**（`72/100` · `→ 403` · `2555 秒`），比只给日期强，且是本仓主流写法。
- **复述别人的实测 MUST 点名是谁测的** —— 无主语的「实测」会让读者以为你复算过。
- 🚫 **MUST NOT 用自评置信度代替出处**（「大概 / 应该是 / 比较确定」）。二元：给得出出处，或直说未验证。
- `ASSUMED:` MUST 答「它错了会怎样」——反推的结论会过期，且过期时不报错。

canonical（含 codetag 完整写法与出处形式表）：[`docs/conventions/comment-provenance.md`](../../docs/conventions/comment-provenance.md)
