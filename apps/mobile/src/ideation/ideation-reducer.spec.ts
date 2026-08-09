// 032 T014 — ideation 澄清态机纯 reducer 单测（穷举态转换 + 并发边界）。流 IO + 屏交互
// 留 T017 e2e（per 测试分层 vitest=logic）。
import { describe, expect, it } from 'vitest';
import {
  hydratedAttachmentUris,
  ideationReducer,
  initialIdeationState,
  type IdeationState,
  type NormalizedSuggestion,
} from './ideation-reducer';

const suggestion: NormalizedSuggestion = {
  question: '面向谁？',
  options: [
    { label: '所有用户', recommended: true },
    { label: '我再想想', escapeHatch: true },
  ],
  multi_select: false,
  allow_freetext: true,
};

/** 推到 streaming 态（已 append user + 空 assistant 占位）。 */
function streaming(content = '想加收藏功能'): IdeationState {
  return ideationReducer(initialIdeationState, { type: 'send', content });
}

describe('ideationReducer (T014 态机)', () => {
  it('初始 idle 空 turns', () => {
    expect(initialIdeationState.status).toBe('idle');
    expect(initialIdeationState.turns).toEqual([]);
  });

  it('send → streaming，append user turn + 空 assistant 占位，记 lastUserContent', () => {
    const s = streaming('  想加收藏功能  ');
    expect(s.status).toBe('streaming');
    expect(s.lastUserContent).toBe('想加收藏功能'); // trim
    expect(s.turns).toEqual([
      { role: 'user', content: '想加收藏功能', status: 'completed' },
      { role: 'assistant', content: '', status: 'streaming' },
    ]);
  });

  it('🚨 streaming 态拒再发（并发边界，返回原引用）', () => {
    const s = streaming();
    const again = ideationReducer(s, { type: 'send', content: '又发一条' });
    expect(again).toBe(s);
  });

  it('空白输入拒发', () => {
    const s = ideationReducer(initialIdeationState, { type: 'send', content: '   ' });
    expect(s).toBe(initialIdeationState);
  });

  it('token 累加到末尾 assistant 占位（打字机）', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'token', token: '这' });
    s = ideationReducer(s, { type: 'token', token: '个收藏' });
    expect(s.turns[1]).toEqual({ role: 'assistant', content: '这个收藏', status: 'streaming' });
  });

  it('suggestion 收口挂到末尾 assistant turn（chips 解析）', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'token', token: '面向谁？' });
    s = ideationReducer(s, { type: 'suggestion', suggestion });
    expect(s.turns[1]?.suggestion).toEqual(suggestion);
  });

  it('done → assistant 定型 completed，保留 chips', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'suggestion', suggestion });
    s = ideationReducer(s, { type: 'done' });
    expect(s.status).toBe('done');
    expect(s.turns[1]?.status).toBe('completed');
    expect(s.turns[1]?.suggestion).toEqual(suggestion);
  });

  it('stopped → 保留半成品 assistant 标 stopped', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'token', token: '半成品' });
    s = ideationReducer(s, { type: 'stopped' });
    expect(s.status).toBe('stopped');
    expect(s.turns[1]).toEqual({ role: 'assistant', content: '半成品', status: 'stopped' });
  });

  it('error → 移除空 assistant 占位，保留 user turn + error 文案', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'error', message: 'provider 失败' });
    expect(s.status).toBe('error');
    expect(s.error).toBe('provider 失败');
    expect(s.turns).toEqual([{ role: 'user', content: '想加收藏功能', status: 'completed' }]);
  });

  it('error → retry 补回 assistant 占位、回 streaming，不重复 user turn', () => {
    let s = streaming();
    s = ideationReducer(s, { type: 'error', message: 'x' });
    s = ideationReducer(s, { type: 'retry' });
    expect(s.status).toBe('streaming');
    expect(s.error).toBeNull();
    expect(s.turns).toEqual([
      { role: 'user', content: '想加收藏功能', status: 'completed' },
      { role: 'assistant', content: '', status: 'streaming' },
    ]);
  });

  it('retry 在非 error 态忽略', () => {
    const s = streaming();
    expect(ideationReducer(s, { type: 'retry' })).toBe(s);
  });

  it('迟到 token（非 streaming）忽略', () => {
    const done = ideationReducer(streaming(), { type: 'done' });
    expect(ideationReducer(done, { type: 'token', token: '迟到' })).toBe(done);
  });

  it('reset 无条件回 idle 空态', () => {
    const s = ideationReducer(streaming(), { type: 'token', token: 'x' });
    expect(ideationReducer(s, { type: 'reset' })).toEqual(initialIdeationState);
  });

  it('hydrate 空 → idle；有内容 → done，回填 assistant chips', () => {
    expect(ideationReducer(initialIdeationState, { type: 'hydrate', turns: [] }).status).toBe(
      'idle',
    );
    const s = ideationReducer(initialIdeationState, {
      type: 'hydrate',
      turns: [
        { role: 'user', content: '想加收藏', status: 'completed' },
        { role: 'assistant', content: '面向谁？', status: 'completed', suggestion },
      ],
    });
    expect(s.status).toBe('done');
    expect(s.turns[1]?.suggestion).toEqual(suggestion);
  });

  it('hydrate 在 streaming 态拒回灌（挡中途 race）', () => {
    const s = streaming();
    expect(ideationReducer(s, { type: 'hydrate', turns: [] })).toBe(s);
  });
});

describe('hydratedAttachmentUris（036 T021 FR-009 server ossKey → 缩略 URL）', () => {
  const BASE = 'https://mbw-imgs.oss-cn-shanghai.aliyuncs.com';

  it('ossKey 列表 → <base>/<ossKey> 完整 URL（保序）', () => {
    expect(hydratedAttachmentUris(['ideation/42/a/img', 'ideation/42/b/img'], BASE)).toEqual([
      `${BASE}/ideation/42/a/img`,
      `${BASE}/ideation/42/b/img`,
    ]);
  });

  it('base 末尾斜杠 / ossKey 前导斜杠归一（不双斜杠）', () => {
    expect(hydratedAttachmentUris(['/ideation/42/a/img'], `${BASE}/`)).toEqual([
      `${BASE}/ideation/42/a/img`,
    ]);
  });

  it('base 空（OSS 未配置 / 缺 env）→ 空数组（不渲断图）', () => {
    expect(hydratedAttachmentUris(['ideation/42/a/img'], '')).toEqual([]);
  });

  it('无 ossKey（纯文本轮）→ 空数组', () => {
    expect(hydratedAttachmentUris([], BASE)).toEqual([]);
    expect(hydratedAttachmentUris([''], BASE)).toEqual([]);
  });
});

describe('ideationReducer · 036 T021 重载带图轮缩略（FR-009）', () => {
  const uris = [
    'https://mbw-imgs.oss-cn-shanghai.aliyuncs.com/ideation/42/a/img',
    'https://mbw-imgs.oss-cn-shanghai.aliyuncs.com/ideation/42/b/img',
  ];

  it('hydrate 带图 user 轮回填 attachmentPreviewUris（server 派生 URL）', () => {
    const s = ideationReducer(initialIdeationState, {
      type: 'hydrate',
      turns: [
        { role: 'user', content: '看这两张图', status: 'completed', attachmentUris: uris },
        { role: 'assistant', content: '聚焦哪块?', status: 'completed' },
      ],
    });
    expect(s.turns[0]?.attachmentPreviewUris).toEqual(uris);
    // assistant 轮 / 无附件轮不挂图（零回归）。
    expect(s.turns[1]?.attachmentPreviewUris).toBeUndefined();
  });

  it('hydrate 纯文本 user 轮（无 attachmentUris）→ 不挂缩略', () => {
    const s = ideationReducer(initialIdeationState, {
      type: 'hydrate',
      turns: [{ role: 'user', content: '纯文字', status: 'completed' }],
    });
    expect(s.turns[0]?.attachmentPreviewUris).toBeUndefined();
  });

  it('发送态用本地乐观 uri（send → streaming 轮）', () => {
    const sent = ideationReducer(initialIdeationState, {
      type: 'send',
      content: '本地图',
      attachmentPreviewUris: ['file:///local/a.jpg'],
    });
    expect(sent.turns[0]?.attachmentPreviewUris).toEqual(['file:///local/a.jpg']);
  });

  it('重载态择一：hydrate 整 turns 由 server 重建（用 server URL，不残留旧本地 uri）', () => {
    // 既有 done 态会话（曾乐观挂本地 uri）→ 冷启 hydrate 整数组重建为 server 真相源 URL。
    const stale: IdeationState = {
      ...initialIdeationState,
      status: 'done',
      turns: [{ role: 'user', content: '本地图', status: 'completed' }],
    };
    const reloaded = ideationReducer(stale, {
      type: 'hydrate',
      turns: [{ role: 'user', content: '本地图', status: 'completed', attachmentUris: uris }],
    });
    // 同一轮只剩 server 派生 URL（hydrate 不并入旧本地 uri —— 整数组 from scratch 重建）。
    expect(reloaded.turns[0]?.attachmentPreviewUris).toEqual(uris);
  });

  it('🚨 server 派生空时回退保留前态乐观本地 uri（dev 缺 OSS base → 不抹掉刚发的图，FR-009）', () => {
    // onDone→invalidate→hydrate：前态 user 轮乐观挂本地 file:// uri；server 重取无可派生 URL
    // （dev 缺 EXPO_PUBLIC_OSS_PUBLIC_BASE_URL → attachmentUris 空）。位置对齐 + 同 role=user +
    // 同 content → 回退保留本地 uri（与 sources/notice 同款瞬时态保留），否则图消失（flash-then-gone）。
    const local = ['file:///local/a.jpg'];
    const prevState: IdeationState = {
      ...initialIdeationState,
      status: 'done',
      turns: [
        {
          role: 'user',
          content: '这张改成红色',
          status: 'completed',
          attachmentPreviewUris: local,
        },
        { role: 'assistant', content: '收到', status: 'completed' },
      ],
    };
    const hydrated = ideationReducer(prevState, {
      type: 'hydrate',
      turns: [
        { role: 'user', content: '这张改成红色', status: 'completed', attachmentUris: [] },
        { role: 'assistant', content: '收到', status: 'completed' },
      ],
    });
    expect(hydrated.turns[0]?.attachmentPreviewUris).toEqual(local);
  });

  it('server 派生优先于前态本地 uri（server 有 ossKey → 用 server URL，prod 重载真相源）', () => {
    // 回退仅在 server 派生为空时兜底；server 有值（prod OSS base 配齐）则 server 真相源优先。
    const prevState: IdeationState = {
      ...initialIdeationState,
      status: 'done',
      turns: [
        {
          role: 'user',
          content: '本地图',
          status: 'completed',
          attachmentPreviewUris: ['file:///local/a.jpg'],
        },
      ],
    };
    const reloaded = ideationReducer(prevState, {
      type: 'hydrate',
      turns: [{ role: 'user', content: '本地图', status: 'completed', attachmentUris: uris }],
    });
    expect(reloaded.turns[0]?.attachmentPreviewUris).toEqual(uris);
  });
});

describe('ideationReducer · 034 接地 repo 选择', () => {
  it('初始 repo=null（未选不接地）', () => {
    expect(initialIdeationState.repo).toBe(null);
  });

  it('set-repo 锁定目标 repo，不动态机/turns', () => {
    const s = ideationReducer(initialIdeationState, { type: 'set-repo', repo: 'mono' });
    expect(s.repo).toBe('mono');
    expect(s.status).toBe('idle');
    expect(s.turns).toEqual([]);
  });

  it('repo 选择延续到流式轮（send 后不丢）', () => {
    let s = ideationReducer(initialIdeationState, { type: 'set-repo', repo: 'mono' });
    s = ideationReducer(s, { type: 'send', content: '想加收藏' });
    expect(s.repo).toBe('mono');
  });

  it('切仓只改 repo（既有 turns 不回改，FR-006）', () => {
    let s = ideationReducer(initialIdeationState, { type: 'set-repo', repo: 'mono' });
    s = ideationReducer(s, { type: 'send', content: 'q1' });
    s = ideationReducer(s, { type: 'done' });
    const before = s.turns;
    s = ideationReducer(s, { type: 'set-repo', repo: 'agent-platform' });
    expect(s.repo).toBe('agent-platform');
    expect(s.turns).toBe(before); // turns 引用不变 = 历史不动
  });

  it('hydrate 回填 session.repo；缺省 null', () => {
    const withRepo = ideationReducer(initialIdeationState, {
      type: 'hydrate',
      turns: [],
      repo: 'mono',
    });
    expect(withRepo.repo).toBe('mono');
    const without = ideationReducer(initialIdeationState, { type: 'hydrate', turns: [] });
    expect(without.repo).toBe(null);
  });
});

describe('ideationReducer · 034 接地检索指示 + 来源', () => {
  const srcA = { relPath: 'a.ts', startLine: 1, endLine: 5, symbol: 'foo' };
  const srcB = { relPath: 'b.ts', startLine: 10, endLine: 12 };
  const sources = [srcA, srcB];

  it('初始 retrieving=false', () => {
    expect(initialIdeationState.retrieving).toBe(false);
  });

  it('tool_start → retrieving=true（streaming 态）', () => {
    const s = ideationReducer(streaming(), { type: 'tool_start' });
    expect(s.retrieving).toBe(true);
  });

  it('首 token 到达清检索指示（retrieving→false）', () => {
    let s = ideationReducer(streaming(), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'token', token: '据代码' });
    expect(s.retrieving).toBe(false);
  });

  it('sources 挂当前 assistant turn（≤5）', () => {
    let s = ideationReducer(streaming(), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'sources', sources });
    expect(s.turns[1]?.sources).toEqual(sources);
  });

  it('多轮来源各自归属对应 turn，不混淆不堆叠历史（US1 AC3）', () => {
    // 第一轮：检索 + 来源 A + 完成。
    let s = ideationReducer(streaming('q1'), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'sources', sources: [srcA] });
    s = ideationReducer(s, { type: 'token', token: 'a1' });
    s = ideationReducer(s, { type: 'done' });
    // 第二轮：检索 + 来源 B + 完成。
    s = ideationReducer(s, { type: 'send', content: 'q2' });
    s = ideationReducer(s, { type: 'tool_start' });
    s = ideationReducer(s, { type: 'sources', sources: [srcB] });
    s = ideationReducer(s, { type: 'token', token: 'a2' });
    s = ideationReducer(s, { type: 'done' });

    const assistants = s.turns.filter((t) => t.role === 'assistant');
    expect(assistants[0]?.sources).toEqual([srcA]); // 第一轮只挂 A
    expect(assistants[1]?.sources).toEqual([srcB]); // 第二轮只挂 B，不混
  });

  it('🚨 hydrate 保留前态 sources（SSE 瞬时不落库 → 终态 invalidate 重取不抹掉，US1 AC3）', () => {
    // 一轮：检索命中 + done → 内存挂 sources。
    let s = ideationReducer(streaming('q1'), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'sources', sources });
    s = ideationReducer(s, { type: 'token', token: 'a1' });
    s = ideationReducer(s, { type: 'done' });
    // 终态 invalidate → 重取详情 hydrate（server turn 无 sources 字段，per plan §5「瞬时不落」）。
    const hydrated = ideationReducer(s, {
      type: 'hydrate',
      turns: [
        { role: 'user', content: 'q1', status: 'completed' },
        { role: 'assistant', content: 'a1', status: 'completed' },
      ],
    });
    // 位置对齐保留前态 sources（不抹掉刚流式出的来源折叠）。
    expect(hydrated.turns[1]?.sources).toEqual(sources);
  });

  it('done / stopped / error 终态清检索指示', () => {
    const base = ideationReducer(streaming(), { type: 'tool_start' });
    expect(ideationReducer(base, { type: 'done' }).retrieving).toBe(false);
    expect(ideationReducer(base, { type: 'stopped' }).retrieving).toBe(false);
    expect(ideationReducer(base, { type: 'error', message: 'x' }).retrieving).toBe(false);
  });

  it('非 streaming 态 tool_start / sources 忽略（迟到帧）', () => {
    expect(ideationReducer(initialIdeationState, { type: 'tool_start' })).toBe(
      initialIdeationState,
    );
    expect(ideationReducer(initialIdeationState, { type: 'sources', sources })).toBe(
      initialIdeationState,
    );
  });
});

describe('ideationReducer · 034 接地降级系统气泡（T011 notice）', () => {
  it('notice 挂当前 assistant turn（一次性系统提示态），不动态机/会话继续', () => {
    let s = ideationReducer(streaming(), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'notice', notice: '本次未接地' });
    expect(s.status).toBe('streaming'); // 不中断（FR-008）
    expect(s.retrieving).toBe(false); // 降级即收检索指示
    expect(s.turns[1]?.notice).toBe('本次未接地');
  });

  it('notice 后 token 继续累加、done 正常收口（会话不中断）', () => {
    let s = ideationReducer(streaming(), { type: 'tool_start' });
    s = ideationReducer(s, { type: 'notice', notice: '本次未接地' });
    s = ideationReducer(s, { type: 'token', token: '据常规' });
    s = ideationReducer(s, { type: 'done' });
    expect(s.status).toBe('done');
    expect(s.turns[1]?.content).toBe('据常规');
    expect(s.turns[1]?.notice).toBe('本次未接地'); // 收口后 notice 留痕（一次性气泡随轮定型）
  });

  it('与 error 帧区分：notice 不移除 assistant 占位、不进 error 态', () => {
    const noticed = ideationReducer(ideationReducer(streaming(), { type: 'tool_start' }), {
      type: 'notice',
      notice: '本次未接地',
    });
    // notice 保留 user + assistant 两条；error 帧移除 assistant 占位入 error 态（对照）。
    expect(noticed.turns).toHaveLength(2);
    expect(noticed.status).not.toBe('error');
    const errored = ideationReducer(streaming(), { type: 'error', message: 'x' });
    expect(errored.turns).toHaveLength(1);
    expect(errored.status).toBe('error');
  });

  it('notice 各轮各自归属（不堆叠历史）', () => {
    // 第一轮降级。
    let s = ideationReducer(streaming('q1'), { type: 'notice', notice: 'n1' });
    s = ideationReducer(s, { type: 'token', token: 'a1' });
    s = ideationReducer(s, { type: 'done' });
    // 第二轮正常（无 notice）。
    s = ideationReducer(s, { type: 'send', content: 'q2' });
    s = ideationReducer(s, { type: 'token', token: 'a2' });
    s = ideationReducer(s, { type: 'done' });
    const assistants = s.turns.filter((t) => t.role === 'assistant');
    expect(assistants[0]?.notice).toBe('n1');
    expect(assistants[1]?.notice).toBeUndefined();
  });

  it('非 streaming 态 notice 忽略（迟到帧）', () => {
    expect(ideationReducer(initialIdeationState, { type: 'notice', notice: 'late' })).toBe(
      initialIdeationState,
    );
  });

  it('🚨 hydrate 保留前态 notice（SSE 瞬时不落库 → 终态 invalidate 重取不抹掉降级气泡）', () => {
    let s = ideationReducer(streaming('q1'), { type: 'notice', notice: '本次未接地' });
    s = ideationReducer(s, { type: 'token', token: 'a1' });
    s = ideationReducer(s, { type: 'done' });
    const hydrated = ideationReducer(s, {
      type: 'hydrate',
      turns: [
        { role: 'user', content: 'q1', status: 'completed' },
        { role: 'assistant', content: 'a1', status: 'completed' },
      ],
    });
    expect(hydrated.turns[1]?.notice).toBe('本次未接地');
  });
});
