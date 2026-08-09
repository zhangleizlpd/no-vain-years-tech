/**
 * 034 ideation 接地检索 契约冒烟（PR §V 第二层 / sdd.md [Contract-Smoke] 正交两层）。
 *
 * 用**生成的** @nvy/api-client 函数打**真 server**（harness boot 的 testcontainers 后端，全 boot
 * node dist/main.js）验 034 接地接线**新增**端点的契约对齐 + 真落库 + 错误码。聚焦三处缝（server
 * IT〔T007，DI override 注命中〕与 hermetic mock〔T012〕都假设契约都对齐、各自覆盖不到的）：
 *   ① 生成的 typed client 对 `GET /ideation/repos` / `PATCH .../{id}/repo` 的 URL/method/序列化
 *      与真 server 装饰器派生的 openapi 契约**对齐**（orval → 真 server 端到端）；
 *   ② `idea_session.repo` 经 PATCH **真落库**（重读会话详情验 `session.repo` 持久化，非 in-memory）；
 *   ③ 错误码反枚举（越权/不存在 → 404 字节级一致；空白 repo → 400）。
 *
 * 分层职责（spec.md L34 SoT）：本契约冒烟**只验契约对齐 + 真落库**。接地帧（tool_start / sources）
 * 的实际触发由 **T007 server IT**（DI override 注命中的 fake code-index provider）兜底——本就是分层
 * 设计：契约冒烟跑 `node dist/main.js` 真 boot **无 DI override**，默认 fake code-index provider
 * （无参 → catalog 空 + search 永返 []）+ 默认 FakeIdeationLlm 剧本（无 grounding 轮），故澄清轮只验
 * token + [DONE] 帧契约，**不强断 tool_start/sources**（默认骨架无命中，强断会假红）。
 *
 * 大模型出口：harness 设 `IDEATION_FAKE_LLM=1`（ideation.module 绑确定性 FakeIdeationLlmProvider，
 * 默认两相剧本，访谈轮纯 token+chips、不调接地工具）；code-index 出口走 module 默认 fake provider
 * （`CODE_INDEX_PROVIDER` 未设 → FakeCodeIndexProvider()，无配置 → listRepos()=[]、search()=[]），
 * 不打真 code-index / 不依赖外网 / 不依赖 WireGuard 隧道（网络暴露=部署前置，本契约用 fake）。
 *
 * 覆盖（spec FR-004/005/006/010 + SC-002/004 契约面）：
 *   ① 登录（harness 程序化登录拿真 token）→ POST /ideation/sessions 建独立 open 会话（typed client）；
 *   ② GET /ideation/repos → 200，响应形状对齐 `{items:[...]}`（默认 fake 空 catalog → items:[] =
 *      0-ready 分支〔FR-010 空态契约面〕；验形状/契约，不依赖具体仓存在）；
 *   ③ PATCH .../{id}/repo body {repo:'mono'} → 200 SessionResponse 含 repo='mono'（FR-005 写入）；
 *   ④ 真落库：重读 GET .../sessions/{id} 详情 → session.repo=='mono' 持久化（契约冒烟唯一能验、
 *      server IT 不经生成 client、hermetic mock 假设契约对齐都覆盖不到的缝 = A 的核心价值）；
 *   ⑤ 切仓：PATCH .../{id}/repo body {repo:'agent-platform'} → 200 + 重读 repo 覆盖为新值（FR-006）；
 *   ⑥ 澄清轮 SSE（裸 fetch 读流，选仓后）：token 帧 + `[DONE]`（默认剧本无接地轮，不强断接地帧）；
 *   ⑦ 契约对齐错误码：越权/不存在 sessionId PATCH → 404 字节级一致（反枚举）；空白 repo → 400；未认证 → 401。
 *
 * 边界与幂等：ideation 表按 accountId 归属，本 spec 全程新建独立会话（不碰 032 ideation.contract.ts
 * 的会话）；下次 boot 全新 PG 容器，故无 cleanup。
 */
import assert from 'node:assert/strict';
import {
  sessionControllerCreate,
  sessionControllerGet,
  sessionControllerRepos,
  sessionControllerSetRepo,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'ideation-grounding (034)';

const REPO_A = 'mono';
const REPO_B = 'agent-platform';
const USER_TURN = '我想给灵感澄清接一个代码库检索';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① 建独立 open 会话（typed client）：URL/method/序列化对齐 ───────────────────────────────
  const created = await sessionControllerCreate({ title: '接地检索接线' }, cfg);
  assert.equal(created.status, 201, `建会话 expected 201, got ${created.status}`);
  const session = created.data;
  assert.match(session.id, /^\d+$/, '建会话: id 为数字串 (BigInt 序列化)');
  assert.equal(session.status, 'open', '建会话: 初始 status=open');
  assert.equal(session.repo, null, '建会话: repo 初始 null (未选仓)');
  const sessionId = session.id;

  // ── ② GET /ideation/repos → 200 + 响应形状 {items:[...]} 对齐（FR-004 / FR-010 契约面）─────
  // 默认 fake code-index provider 无配置 → listRepos()=[] → items:[]（0-ready 空态分支）。
  // 本契约验**形状对齐**（orval typed client ↔ 真 server openapi），不依赖具体仓存在。
  const catalog = await sessionControllerRepos(cfg);
  assert.equal(catalog.status, 200, `catalog expected 200, got ${catalog.status}`);
  assert.ok(Array.isArray(catalog.data.items), 'catalog: items 为数组 (形状对齐)');
  assert.deepEqual(
    catalog.data.items,
    [],
    'catalog: 默认 fake provider 空 catalog → items:[] (0-ready 分支, FR-010 契约面)',
  );

  // ── ③ PATCH .../{id}/repo body {repo} → 200 SessionResponse 含 repo（FR-005 选仓写入）─────
  const setA = await sessionControllerSetRepo(sessionId, { repo: REPO_A }, cfg);
  assert.equal(setA.status, 200, `set-repo expected 200, got ${setA.status}`);
  assert.equal(setA.data.id, sessionId, 'set-repo: 响应会话 id 一致');
  assert.equal(setA.data.repo, REPO_A, `set-repo: 响应 repo='${REPO_A}' (写入即回显)`);

  // ── ④ 真落库：重读会话详情 → session.repo 持久化（契约冒烟核心价值, server IT/mock 覆盖不到）─
  const detailA = await sessionControllerGet(sessionId, cfg);
  assert.equal(detailA.status, 200, `查会话详情 expected 200, got ${detailA.status}`);
  assert.equal(
    detailA.data.repo,
    REPO_A,
    `落库 idea_session.repo: 重读详情 repo='${REPO_A}' (PATCH 真落库, 非 in-memory)`,
  );

  // ── ⑤ 切仓：PATCH 新 repo → 200 + 重读覆盖为新值（FR-006 后续轮换命名空间）──────────────────
  const setB = await sessionControllerSetRepo(sessionId, { repo: REPO_B }, cfg);
  assert.equal(setB.status, 200, `切仓 set-repo expected 200, got ${setB.status}`);
  assert.equal(setB.data.repo, REPO_B, `切仓: 响应 repo 覆盖为 '${REPO_B}'`);
  const detailB = await sessionControllerGet(sessionId, cfg);
  assert.equal(
    detailB.data.repo,
    REPO_B,
    `切仓落库: 重读详情 repo 覆盖为 '${REPO_B}' (FR-006, 后续轮换命名空间)`,
  );

  // ── ⑥ 澄清轮 SSE（裸 fetch 读流，已选仓）：token 帧 + [DONE]；默认剧本无接地轮不强断接地帧 ────
  // 默认 FakeIdeationLlm 剧本访谈轮只 token+chips、不调 codeindex_retrieval；默认 fake code-index
  // search()=[]。故本轮只验澄清流式契约（token + [DONE]）；tool_start/sources 帧的实际触发由 T007
  // server IT（DI override 注命中）兜底——分层设计，此处不强断（默认骨架无命中，强断必假红）。
  const turn = await streamTurn(ctx, sessionId, USER_TURN);
  assert.ok(turn.tokens.length > 0, 'SSE 澄清轮: 读到 ≥1 个 token 帧 (question 逐帧 drip)');
  assert.ok(turn.done, 'SSE 澄清轮: 收到 [DONE] 哨兵 (流正常结束)');
  assert.equal(turn.error, null, 'SSE 澄清轮: 无 error 帧 (选仓 + 默认剧本不中断)');

  // ── ⑦ 契约对齐错误码：越权/不存在 → 404 字节级一致；空白 repo → 400；未认证 → 401 ──────────
  await assertSetRepoNotFound(cfg);
  await assertSetRepoBlankRejected(sessionId, cfg);
  await assertReposUnauthenticated(ctx);
}

/** SSE 澄清轮单次解析结果（与 032 ideation.contract.ts 同款薄解析）。 */
interface TurnResult {
  tokens: string[];
  done: boolean;
  error: string | null;
}

/**
 * 裸 fetch 消费 ideation 澄清轮 SSE 端点（orval 不生成此端点函数 — 产 text/event-stream）。
 * 解 token 帧 / `[DONE]` 哨兵 / error 帧；跨 chunk 半帧用 buffer 累积（同 032 冒烟分帧逻辑）。
 * 接地帧（tool_start / sources / notice）默认剧本不产，本薄解析不抽——由 T007 IT 兜底验。
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
        const parsed = JSON.parse(payload) as { token?: string; error?: string };
        if (parsed.error !== undefined) {
          error = parsed.error;
        } else if (parsed.token !== undefined) {
          tokens.push(parsed.token);
        }
      }
      sep = buffer.indexOf('\n\n');
    }
  }
  return { tokens, done, error };
}

// 越权 / 不存在 / 非数字 sessionId set-repo → 404（字节级一致反枚举：与 get/delete/reopen 同款,
// SESSION_NOT_FOUND 不暴露 ProblemDetail.code 区分三态）。
async function assertSetRepoNotFound(cfg: {
  baseURL: string;
  headers: Record<string, string>;
}): Promise<void> {
  await assert.rejects(
    () => sessionControllerSetRepo('999999999', { repo: REPO_A }, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 404, '越权/不存在 sessionId set-repo → 404 (反枚举)');
      return true;
    },
  );
}

// 空白 repo（trim 后空）→ 400（DTO @minLength 1 + trim 校验）。
async function assertSetRepoBlankRejected(
  sessionId: string,
  cfg: { baseURL: string; headers: Record<string, string> },
): Promise<void> {
  await assert.rejects(
    () => sessionControllerSetRepo(sessionId, { repo: '   ' }, cfg),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 400, '空白 repo set-repo → 400 (DTO 校验)');
      return true;
    },
  );
}

// 无 Bearer → 401（authed catalog 端点，反枚举统一 401）。带 baseURL 但不带 authorization header。
async function assertReposUnauthenticated(ctx: RealBackendCtx): Promise<void> {
  await assert.rejects(
    () => sessionControllerRepos({ baseURL: ctx.api }),
    (err: unknown) => {
      const e = err as { response?: { status?: number } };
      assert.equal(e.response?.status, 401, '未认证 catalog → 401');
      return true;
    },
  );
}
