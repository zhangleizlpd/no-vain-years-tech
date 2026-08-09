# 取数 — 两种输入

## 输入模式自动识别

| 用户给的东西                                                     | 走哪条                                           |
| ---------------------------------------------------------------- | ------------------------------------------------ |
| 数字 / "session 5" / "第 N 个会话" / 会话标题（如"灵感需求 v2"） | A. 连本地 DB                                     |
| 一整段对话文本 / 导出的 markdown / 截图转录                      | B. 解析粘贴文本                                  |
| 只给标题没说清是哪条                                             | 先跑 A 的列表查询，把候选 session 列出来让用户认 |

---

## A. 本地 DB（`mbw_poc`，ideation schema）

dev DB = `docker-compose.dev.yml` 的 `mbw-poc-postgres` 容器，PG 端口 5433，库 `mbw_poc`。
经容器 `psql` 取数（不依赖本机装 psql / 不依赖 server 在跑）。

### A.1 先列 session 认人

```bash
docker exec mbw-poc-postgres psql -U mbw -d mbw_poc -c \
  "SELECT id, account_id, title, status, created_at, updated_at FROM ideation.idea_session ORDER BY updated_at DESC LIMIT 20;"
```

`status` 取值：`open`（澄清中）/ `converged`（已生成 brief）/ `handed-off`（已交接，对应 UI「已交接」）等。

### A.2 拉某 session 的全部轮次（含 chips）

`role = user|assistant`；`suggestion` 是本轮 chips 的 Json（`{question, options, recommended, multi_select, allow_freetext}`），**评 chips 利用率/质量靠它**。`id` 自增即时序，按 `id` 升序就是对话顺序。

```bash
docker exec mbw-poc-postgres psql -U mbw -d mbw_poc -At \
  -c "SELECT json_agg(json_build_object('id',id,'role',role,'content',content,'suggestion',suggestion) ORDER BY id) FROM ideation.idea_turn WHERE session_id=<ID>;" \
  > /tmp/ideation_turns.json
```

漂亮打印（含 chips 摘要）：

```bash
python3 - <<'PY'
import json
d=json.load(open('/tmp/ideation_turns.json'))
for t in d:
    s=t.get('suggestion'); tag=''
    if s:
        tag=f"\n   └─[chips] Q={s.get('question','')!r} multi={s.get('multi_select')} freetext={s.get('allow_freetext')}\n        opts={s.get('options',[])}"
    print(f"[{t['id']:>3}] {t['role']:<9}| {t['content']}{tag}\n")
PY
```

> ⚠️ psql 终端输出会被截断——**用上面 json + python 打印**，别用裸 `-c "SELECT ... content"`（长内容会被切，看不全后半段对话）。

### A.3 拉最终产出 brief（15 段全量）

```bash
docker exec mbw-poc-postgres psql -U mbw -d mbw_poc -At \
  -c "SELECT brief_json FROM ideation.requirements_draft WHERE session_id=<ID>;" \
  | python3 -m json.tool --no-ensure-ascii
```

无行 = 还没生成 brief（session 仍 `open`）→ 只能评过程，产出端标「未生成」。

### A.4 三表关系速记

- `idea_session` 1—N `idea_turn`（`session_id` 逻辑引用，无声明 FK）。
- `idea_session` 1—1 `requirements_draft`（`session_id @unique`）。
- `brief_json` 段落分层见 `grounding.md`（T1 五段必填 / T2 接地 / T3 可选）。

---

## B. 粘贴的对话 markdown

用户直接贴对话时：

1. **切轮**：按 `用户/我:` vs `助手/DS/assistant:` 之类标记切 user/assistant 轮；切不干净就先回报"我把它切成了 N 轮 user + M 轮 assistant，对吗"让用户确认。
2. **chips 信息可能丢**：粘贴文本通常没有 suggestion 结构 → chips 利用率/质量维度标「数据不可得」，不强行推断。
3. **brief**：用户能贴出最终 brief 就一起评产出端；贴不出就只评过程。
4. 其余流程与 A 相同。

---

## 隐私 / 账号

`account_id` 只是 JWT sub 的逻辑值，复盘不需要解析到真实用户；报告里用 `account_id=<n>` 即可，不外发、不写入 memory。
