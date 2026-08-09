/**
 * 032 ideation 需求灵感澄清 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，
 * 全 boot node dist/main.js）验 ideation 两相闭环端到端 + 真落库 3 表 + 契约对齐。澄清轮 SSE
 * 端点（POST .../turns）产 `text/event-stream`（非 JSON），orval 没生成消费函数（mobile 自写
 * expo/fetch 客户端），故本 node 层用裸 `fetch` 读 SSE 流；建会话 / 生成 / 导出走生成的 typed
 * client 函数。
 *
 * 大模型出口：真 server 由 harness 设 `IDEATION_FAKE_LLM=1` → ideation.module 绑确定性
 * FakeIdeationLlmProvider，bake 默认三轮剧本 `IDEATION_FAKE_SCRIPT`（访谈第一问纯文本、第二问出
 * question + chips 含推荐项、产出轮出 T1 五段齐 brief；不打真 DeepSeek/M3、不依赖外网），保契约
 * 冒烟确定 + 离线可跑。provider 单例 round 游标单调：ideation 流程内 stream 调用序固定 = [澄清轮1
 * （round 0 = 第一问 ask, 反锚定无 chips）, 澄清轮2（round 1 = 第二问 ask, 出 chips）, 产出轮
 * （round 2 = emit）]，与脚本三轮一一对位。
 *
 * 覆盖（spec FR + SC-001/002）：
 *   ① 登录（harness 程序化登录拿真 token）→ POST /ideation/sessions 建 open 会话（typed client）；
 *   ② 澄清轮1 SSE（裸 fetch 读流）：token 帧（question 逐帧 drip）+ `[DONE]`；第一问反锚定无 chips；
 *   ③ 澄清轮2 SSE：token 帧 + 1 个 **suggestion 帧**（chips 收口整出，含「（推荐）」+ 末位逃生项）
 *      + `[DONE]` → 流式读到 token + chips（T020 核心：补 mock 与 IT 缝）；
 *   ④ POST .../brief 生成（typed client）：converged=true + briefJson T1 五段齐 + missing 空；
 *   ⑤ GET .../brief/export 导出（typed client）：markdown 非空 + status=handed-off；
 *   ⑥ 真落库 3 表（GET .../sessions/{id} 详情 + 错误码反枚举）：
 *      - idea_session：status 终态 handed-off（open→converged→handed-off 全链路真转换）；
 *      - idea_turn：role user + assistant 交替按插入序（4 轮）、content 正确、轮2 assistant 携 suggestion；
 *      - requirements_draft：1:1 单份 brief（briefJson T1 五段，session 详情内嵌 brief 非 null）；
 *   ⑦ 契约对齐：建会话 URL/method/序列化（id BigInt → 数字串）；越权/不存在 sessionId → 404 字节级
 *      一致（反枚举）；未认证 → 401。
 *
 * 边界与幂等：ideation 表按 accountId 归属，本 spec 全程新建独立会话；DELETE 端点存在但本 spec
 * 留痕（属测试 account，下次 boot 全新 PG 容器），不污染其他 spec，故无 cleanup。
 */
import assert from 'node:assert/strict';
import {
  sessionControllerCreate,
  sessionControllerGet,
  briefControllerGenerate,
  briefControllerExport,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'ideation (032)';

// FakeIdeationLlmProvider 默认剧本镜像（ideation.module IDEATION_FAKE_SCRIPT 的 ask question）。
// question 逐帧 drip 后拼接 = 这些文本；含中文多字节验 SSE 编码端到端。
const FAKE_QUESTION_1 = '你想解决的核心问题是什么?';
const FAKE_QUESTION_2 = '复用现有自选股清单还是独立收藏?';
// 推荐选项（round 1 ask 的 recommended 项）—— suggestion 帧归一化后排首；label 落库**干净**，
// 「（推荐）」由前端 Chip 据 recommended 渲染装饰（normalizeSuggestion stripRecommendedSuffix，per #524）。
const FAKE_RECOMMENDED_LABEL = '复用自选股清单';
const ESCAPE_HATCH_LABEL = '都不是/自己填';

const USER_TURN_1 = '我想给行情页加一个收藏功能';
const USER_TURN_2 = '复用现有自选股清单';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① 建 open 会话（typed client）：URL/method/序列化对齐 ──────────────────────────────
  const created = await sessionControllerCreate({ title: '给行情页加收藏' }, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const session = created.data;
  assert.match(session.id, /^\d+$/, '建会话: id 为数字串 (BigInt 序列化)');
  assert.equal(session.title, '给行情页加收藏', '建会话: title 原样');
  assert.equal(session.status, 'open', '建会话: 初始 status=open');
  assert.equal(session.repo, null, '建会话: repo 恒 null (接地缝本期不暴露)');
  const sessionId = session.id;

  // ── ② 澄清轮1 SSE（裸 fetch 读流）：token 帧 + [DONE]；第一问反锚定无 chips ─────────────
  // round 0 = 第一问 ask（纯文本）→ question 逐帧 drip；turnIndex=0 反锚定不给 chips。
  const turn1 = await streamTurn(ctx, sessionId, USER_TURN_1);
  assert.ok(turn1.tokens.length > 0, 'SSE 轮1: 读到 ≥1 个 token 帧 (question 逐帧 drip)');
  assert.equal(turn1.tokens.join(''), FAKE_QUESTION_1, 'SSE 轮1: token 拼接 = 第一问 question');
  assert.ok(turn1.done, 'SSE 轮1: 收到 [DONE] 哨兵 (流正常结束)');
  assert.equal(turn1.suggestion, null, 'SSE 轮1: 第一问反锚定 → 无 suggestion 帧');
  assert.equal(turn1.error, null, 'SSE 轮1: 无 error 帧');

  // ── ③ 澄清轮2 SSE：token 帧 + suggestion 帧（chips）+ [DONE] —— T020 核心读到 token + chips ─
  // round 1 = 第二问 ask（含 recommended 选项）→ turnIndex=1 过两闸 → 收口 suggestion 帧。
  const turn2 = await streamTurn(ctx, sessionId, USER_TURN_2);
  assert.ok(turn2.tokens.length > 0, 'SSE 轮2: 读到 ≥1 个 token 帧');
  assert.equal(turn2.tokens.join(''), FAKE_QUESTION_2, 'SSE 轮2: token 拼接 = 第二问 question');
  assert.ok(turn2.done, 'SSE 轮2: 收到 [DONE] 哨兵');
  assert.equal(turn2.error, null, 'SSE 轮2: 无 error 帧');
  // chips 帧：收口整出 NormalizedSuggestion（question + options[] + multi_select + allow_freetext）。
  const sug = turn2.suggestion;
  assert.ok(sug !== null, 'SSE 轮2: 读到 suggestion 帧 (chips, 第二问过两闸)');
  assert.equal(sug.question, FAKE_QUESTION_2, 'SSE 轮2 chips: question 一致');
  assert.equal(sug.allow_freetext, true, 'SSE 轮2 chips: allow_freetext 恒 true (逃生口永驻)');
  assert.equal(sug.multi_select, false, 'SSE 轮2 chips: multi_select=false (单选)');
  const opts = sug.options as Array<{ label: string; recommended: boolean; escapeHatch: boolean }>;
  assert.ok(Array.isArray(opts) && opts.length >= 2, 'SSE 轮2 chips: options ≥2 (含逃生项)');
  assert.equal(
    opts[0].label,
    FAKE_RECOMMENDED_LABEL,
    'SSE 轮2 chips: 推荐项排首 (label 落库干净, 无「（推荐）」后缀)',
  );
  assert.equal(opts[0].recommended, true, 'SSE 轮2 chips: 首项 recommended=true');
  const last = opts[opts.length - 1];
  assert.equal(last.label, ESCAPE_HATCH_LABEL, 'SSE 轮2 chips: 末位逃生项「都不是/自己填」');
  assert.equal(last.escapeHatch, true, 'SSE 轮2 chips: 末位 escapeHatch=true');

  // ── ④ POST .../brief 生成（typed client）：收敛 + T1 五段齐 + missing 空 ───────────────
  // 产出轮 forced emit (round 2) → 默认剧本 emit 出 T1 五段齐 brief → 收敛门过 → 落库 + open→converged。
  const gen = await briefControllerGenerate(sessionId, cfg);
  assert.equal(gen.status, 200, `生成 brief expected 200, got ${gen.status}`);
  assert.equal(gen.data.converged, true, '生成 brief: converged=true (T1 五段齐, 收敛门过)');
  assert.deepEqual(gen.data.missing, [], '生成 brief: missing 空 (无缺段)');
  const briefJson = gen.data.briefJson as Record<string, unknown> | null;
  assert.ok(
    briefJson !== null && typeof briefJson === 'object',
    '生成 brief: briefJson 非 null 对象',
  );
  for (const seg of [
    'problem',
    'user_stories',
    'functional_requirements',
    'success_criteria',
    'non_goals',
  ]) {
    assert.equal(typeof briefJson[seg], 'string', `生成 brief: T1 段 ${seg} 为非空 string`);
    assert.ok((briefJson[seg] as string).trim().length > 0, `生成 brief: T1 段 ${seg} 非空`);
  }

  // ── ⑤ GET .../brief/export 导出（typed client）：markdown 非空 + handed-off ────────────
  const exp = await briefControllerExport(sessionId, cfg);
  assert.equal(exp.status, 200, `导出 brief expected 200, got ${exp.status}`);
  assert.ok(exp.data.markdown.trim().length > 0, '导出 brief: markdown 非空');
  assert.equal(
    exp.data.status,
    'handed-off',
    '导出 brief: status=handed-off (converged→handed-off)',
  );

  // ── ⑥ 真落库 3 表（GET .../sessions/{id} 详情）─────────────────────────────────────────
  const detail = await sessionControllerGet(sessionId, cfg);
  assert.equal(detail.status, 200, `查会话详情 expected 200, got ${detail.status}`);
  const d = detail.data;

  // idea_session: 状态终态 handed-off（open→converged→handed-off 全链路真转换）。
  assert.equal(d.status, 'handed-off', '落库 idea_session: status 终态 handed-off');
  assert.equal(d.id, sessionId, '落库 idea_session: id 一致');

  // idea_turn: 2 轮 → 4 条 (user/assistant 交替按插入序)、content 正确、轮2 assistant 携 suggestion。
  assert.equal(d.turns.length, 4, '落库 idea_turn: 共 4 条 (2 user + 2 assistant 交替)');
  assert.deepEqual(
    d.turns.map((t) => t.role),
    ['user', 'assistant', 'user', 'assistant'],
    '落库 idea_turn: role 交替序 user→assistant→user→assistant',
  );
  assert.equal(d.turns[0].content, USER_TURN_1, '落库 idea_turn: 轮1 user content 原样');
  assert.equal(d.turns[1].content, FAKE_QUESTION_1, '落库 idea_turn: 轮1 assistant = 第一问全文');
  assert.equal(d.turns[2].content, USER_TURN_2, '落库 idea_turn: 轮2 user content 原样');
  assert.equal(d.turns[3].content, FAKE_QUESTION_2, '落库 idea_turn: 轮2 assistant = 第二问全文');
  // 插入序：id 严格递增（BigInt 数字串比较）。
  for (let i = 1; i < d.turns.length; i++) {
    assert.match(d.turns[i].id, /^\d+$/, `落库 idea_turn: turn[${i}] id 数字串`);
    assert.ok(
      BigInt(d.turns[i].id) > BigInt(d.turns[i - 1].id),
      `落库 idea_turn: id 严格递增 [${i}]`,
    );
  }
  // 轮1 assistant (第一问) 无 chips；轮2 assistant (第二问) 携 suggestion 落库。
  assert.equal(d.turns[1].suggestion, null, '落库 idea_turn: 第一问 assistant 无 suggestion');
  assert.ok(
    d.turns[3].suggestion !== null,
    '落库 idea_turn: 第二问 assistant 携 suggestion (chips 落库)',
  );

  // requirements_draft: 1:1 单份 brief（session 详情内嵌 brief 非 null, briefJson T1 五段）。
  assert.ok(d.brief != null, '落库 requirements_draft: 详情内嵌 brief 非 null (1:1)');
  const draftJson = d.brief.briefJson as Record<string, unknown>;
  assert.equal(
    typeof draftJson.problem,
    'string',
    '落库 requirements_draft: briefJson.problem string',
  );
  assert.equal(
    typeof draftJson.non_goals,
    'string',
    '落库 requirements_draft: briefJson.non_goals string',
  );
  assert.deepEqual(
    draftJson,
    briefJson,
    '落库 requirements_draft: 详情 brief = 生成返回 brief (同一份)',
  );

  // ── ⑦ 契约对齐：错误码（越权/不存在 404 反枚举 + 未认证 401）────────────────────────────
  await assertOtherSessionNotFound(cfg);
  await assertUnauthenticated(ctx);
}

/** SSE 澄清轮单次解析结果。 */
interface TurnResult {
  tokens: string[];
  suggestion: Record<string, unknown> | null;
  done: boolean;
  error: string | null;
}

/**
 * 裸 fetch 消费 ideation 澄清轮 SSE 端点（orval 不生成此端点函数 — 产 text/event-stream）。
 * 解三类帧：`data:{"token":"..."}` 抽 token；`data:{"suggestion":{...}}` 抽 chips 整体；
 * `data:[DONE]` 哨兵；`data:{"error":"..."}` 错误帧。跨 chunk 半帧用 buffer 累积（与 chat 冒烟
 * + mobile sse-parse 同款分帧逻辑，此处 node 层独立薄实现验契约）。
 */
async function streamTurn(
  ctx: RealBackendCtx,
  sessionId: string,
  content: string,
): Promise<TurnResult> {
  const res = await fetch(`${ctx.api}/api/v1/ideation/sessions/${sessionId}/turns`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${ctx.accessToken}`,
    },
    body: JSON.stringify({ content }),
  });
  assert.equal(res.status, 200, `SSE turn expected 200, got ${res.status}`);
  assert.match(
    res.headers.get('content-type') ?? '',
    /text\/event-stream/,
    'SSE: Content-Type text/event-stream',
  );
  assert.ok(res.body, 'SSE: response body 流可读');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const tokens: string[] = [];
  let suggestion: Record<string, unknown> | null = null;
  let done = false;
  let error: string | null = null;
  let buffer = '';

  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });

    let sep = buffer.indexOf('\n\n');
    while (sep !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const payload = frame.startsWith('data:') ? frame.slice('data:'.length).trim() : frame.trim();
      if (payload === '[DONE]') {
        done = true;
      } else if (payload.length > 0) {
        const parsed = JSON.parse(payload) as {
          token?: string;
          suggestion?: Record<string, unknown>;
          error?: string;
        };
        if (parsed.error !== undefined) {
          error = parsed.error;
        } else if (parsed.suggestion !== undefined) {
          suggestion = parsed.suggestion;
        } else if (parsed.token !== undefined) {
          tokens.push(parsed.token);
        }
      }
      sep = buffer.indexOf('\n\n');
    }
  }
  return { tokens, suggestion, done, error };
}

// 越权 / 不存在 / 非数字 sessionId → 404（字节级一致反枚举：仅 status, 与 get/delete 同款,
// SESSION_NOT_FOUND 不暴露 ProblemDetail.code 区分三态）。
async function assertOtherSessionNotFound(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  await assert.rejects(
    () => sessionControllerGet('999999999', cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 404, '越权/不存在 sessionId → 404 (反枚举)');
      return true;
    },
  );
}

// 无 Bearer → 401（authed 端点，反枚举统一 401）。带 baseURL 但不带 authorization header。
async function assertUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => sessionControllerCreate({ title: 't' }, { baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证建会话 → 401');
      return true;
    },
  );
}
