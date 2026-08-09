// 027 T011 — chat 态机纯 reducer 单测（vitest=logic，per 测试分层）。
// hook 的 render / 副作用（orval / expo-fetch / AsyncStorage）留 T013 e2e；本文件只测
// 纯态转换：发送→streaming、token 累加、stop→stopped、error→error、retry→streaming、
// done→done、**streaming 态拒发送**（并发边界，spec Edge）。
import { describe, expect, it } from 'vitest';
import { chatReducer, initialChatState, type ChatState } from './chat-reducer';

const USER_CONTENT = '介绍下 A';

/** 走到 streaming 态（已 append user msg + 空 AI msg），后续转换的公共起点。 */
function streamingState(): ChatState {
  return chatReducer(initialChatState, { type: 'send', content: USER_CONTENT });
}

describe('chatReducer', () => {
  it('initial 态 = idle 空消息', () => {
    expect(initialChatState.status).toBe('idle');
    expect(initialChatState.messages).toEqual([]);
  });

  describe('send', () => {
    it('idle + send → streaming，append user msg + 空 assistant 占位', () => {
      const next = streamingState();
      expect(next.status).toBe('streaming');
      expect(next.messages).toHaveLength(2);
      expect(next.messages[0]).toMatchObject({ role: 'user', content: USER_CONTENT });
      expect(next.messages[1]).toMatchObject({
        role: 'assistant',
        content: '',
        status: 'streaming',
      });
    });

    it('空白 content（纯空格）被拒，态不变', () => {
      const next = chatReducer(initialChatState, { type: 'send', content: '   ' });
      expect(next).toBe(initialChatState);
    });

    it('🚨 streaming 态再 send 被拒（并发边界），不新增消息', () => {
      const streaming = streamingState();
      const next = chatReducer(streaming, { type: 'send', content: '又一条' });
      expect(next).toBe(streaming); // 同引用 = 守卫拦截，无新流
      expect(next.messages).toHaveLength(2);
    });

    it('done 态 send → 进新一轮 streaming（多轮累加，不清历史）', () => {
      const done = chatReducer(streamingState(), { type: 'done' });
      const next = chatReducer(done, { type: 'send', content: '那它和 B 比呢' });
      expect(next.status).toBe('streaming');
      expect(next.messages).toHaveLength(4); // 2 旧 + user + assistant 占位
      expect(next.messages[2]).toMatchObject({ role: 'user', content: '那它和 B 比呢' });
    });
  });

  describe('token', () => {
    it('token 累加到当前 assistant msg（打字机）', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'token', token: '你' });
      s = chatReducer(s, { type: 'token', token: '好' });
      expect(s.messages[1]?.content).toBe('你好');
      expect(s.status).toBe('streaming');
    });

    it('非 streaming 态收到 token 被忽略（迟到帧）', () => {
      const done = chatReducer(chatReducer(streamingState(), { type: 'token', token: 'x' }), {
        type: 'done',
      });
      const next = chatReducer(done, { type: 'token', token: 'late' });
      expect(next).toBe(done);
    });
  });

  describe('done', () => {
    it('streaming + done → done，assistant msg 定型 completed', () => {
      const s = chatReducer(streamingState(), { type: 'token', token: 'hi' });
      const next = chatReducer(s, { type: 'done' });
      expect(next.status).toBe('done');
      expect(next.messages[1]).toMatchObject({ content: 'hi', status: 'completed' });
    });
  });

  describe('stop / stopped', () => {
    it('streaming + stopped → stopped，保留半成品标 stopped', () => {
      const s = chatReducer(streamingState(), { type: 'token', token: '半成' });
      const next = chatReducer(s, { type: 'stopped' });
      expect(next.status).toBe('stopped');
      expect(next.messages[1]).toMatchObject({ content: '半成', status: 'stopped' });
    });
  });

  describe('error', () => {
    it('streaming + error → error，移除空 assistant 占位（失败不落半成品）', () => {
      const s = streamingState();
      const next = chatReducer(s, { type: 'error', message: 'provider 超时' });
      expect(next.status).toBe('error');
      expect(next.error).toBe('provider 超时');
      // 失败半成品不保留（FR-009 不落 failed 占位）；user msg 仍在
      expect(next.messages).toHaveLength(1);
      expect(next.messages[0]).toMatchObject({ role: 'user' });
    });
  });

  describe('retry', () => {
    it('error 态 retry → streaming，复用上一条 user content 重发（FR-009）', () => {
      const errored = chatReducer(streamingState(), { type: 'error', message: 'boom' });
      const next = chatReducer(errored, { type: 'retry' });
      expect(next.status).toBe('streaming');
      // user msg 仍是同一条；新 assistant 占位补回
      expect(next.messages).toHaveLength(2);
      expect(next.messages[0]).toMatchObject({ role: 'user', content: USER_CONTENT });
      expect(next.messages[1]).toMatchObject({
        role: 'assistant',
        content: '',
        status: 'streaming',
      });
    });

    it('非 error 态 retry 被忽略', () => {
      const done = chatReducer(streamingState(), { type: 'done' });
      const next = chatReducer(done, { type: 'retry' });
      expect(next).toBe(done);
    });

    it('retry 暴露 lastUserContent 供 hook 重发', () => {
      const errored = chatReducer(streamingState(), { type: 'error', message: 'boom' });
      expect(errored.lastUserContent).toBe(USER_CONTENT);
    });
  });

  describe('reset（028 新建对话回空态）', () => {
    it('done 态 reset → idle 空消息（清历史）', () => {
      const done = chatReducer(streamingState(), { type: 'done' });
      expect(done.messages.length).toBeGreaterThan(0);
      const next = chatReducer(done, { type: 'reset' });
      expect(next).toEqual(initialChatState);
    });

    it('idle 态 reset → 仍 idle 空态（幂等）', () => {
      const next = chatReducer(initialChatState, { type: 'reset' });
      expect(next).toEqual(initialChatState);
    });

    it('error 态 reset → 清 error 回 idle', () => {
      const errored = chatReducer(streamingState(), { type: 'error', message: 'boom' });
      const next = chatReducer(errored, { type: 'reset' });
      expect(next.status).toBe('idle');
      expect(next.messages).toEqual([]);
      expect(next.error).toBeNull();
    });

    it('🚨 streaming 态 reset → 直接清回 idle（新建对话先 abort 流，无回灌 race）', () => {
      // 与 hydrate 不同：reset 是显式用户动作（新建对话），hook 已先 abort 流 → 无条件清空。
      const next = chatReducer(streamingState(), { type: 'reset' });
      expect(next).toEqual(initialChatState);
    });
  });

  describe('hydrate（冷启 reload 已落库消息）', () => {
    it('hydrate 用服务端消息列表填充 messages，态回 done', () => {
      const next = chatReducer(initialChatState, {
        type: 'hydrate',
        messages: [
          { role: 'user', content: 'Q', status: 'completed' },
          { role: 'assistant', content: 'A', status: 'completed' },
        ],
      });
      expect(next.status).toBe('done');
      expect(next.messages).toHaveLength(2);
      expect(next.messages[1]).toMatchObject({ role: 'assistant', content: 'A' });
    });

    it('hydrate 空列表 → idle', () => {
      const next = chatReducer(initialChatState, { type: 'hydrate', messages: [] });
      expect(next.status).toBe('idle');
      expect(next.messages).toEqual([]);
    });

    it('030 hydrate 回填 assistant 消息的 sources/degraded（冷启动恢复 SC-003）', () => {
      const next = chatReducer(initialChatState, {
        type: 'hydrate',
        messages: [
          { role: 'user', content: 'Q', status: 'completed' },
          {
            role: 'assistant',
            content: 'A',
            status: 'completed',
            sources: [{ index: 1, title: 'T', url: 'https://t.com' }],
            degraded: false,
          },
        ],
      });
      expect(next.messages[1]).toMatchObject({
        role: 'assistant',
        sources: [{ index: 1, title: 'T', url: 'https://t.com' }],
      });
      expect(next.messages[1]?.degraded).toBeUndefined(); // degraded:false 不挂字段
    });

    it('030 hydrate degraded:true 的 assistant 消息标降级', () => {
      const next = chatReducer(initialChatState, {
        type: 'hydrate',
        messages: [{ role: 'assistant', content: 'A', status: 'completed', degraded: true }],
      });
      expect(next.messages[0]?.degraded).toBe(true);
    });

    it('streaming 态拒 hydrate（新建会话冷启 query 中途返回不 clobber 进行中的流）', () => {
      // 模拟：send 已建占位流式态，hydrate query 在流中途返回半截 DB 态（仅 user msg）。
      const streaming = chatReducer(initialChatState, { type: 'send', content: '今天天气怎么样' });
      expect(streaming.status).toBe('streaming');

      const next = chatReducer(streaming, {
        type: 'hydrate',
        messages: [{ role: 'user', content: '今天天气怎么样', status: 'completed' }],
      });

      // 原引用返回 = 被守卫拒；流式态 + assistant 占位完好，后续 token 可继续累加。
      expect(next).toBe(streaming);
      expect(next.status).toBe('streaming');
      expect(next.messages).toHaveLength(2);
      expect(next.messages[1]).toMatchObject({ role: 'assistant', status: 'streaming' });
    });
  });

  describe('030 联网中间态 + sources + degraded', () => {
    it('initial 态 searchProgress = null（无中间态）', () => {
      expect(initialChatState.searchProgress).toBeNull();
    });

    it('tool_result 累加 N = 累计原始页数（F3：可 > 去重来源数）', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 5 });
      expect(s.searchProgress).toBe(5);
      // 第二轮再累加（多轮检索；count 是原始页数，不去重）。
      s = chatReducer(s, { type: 'tool_result', count: 3 });
      expect(s.searchProgress).toBe(8); // 5+3，可 > 最终去重来源数
    });

    it('🚨 answer token 开始 → 清中间态 searchProgress（过渡到答案流，F3）', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 4 });
      expect(s.searchProgress).toBe(4);
      s = chatReducer(s, { type: 'token', token: '答' });
      expect(s.searchProgress).toBeNull();
      // 后续 token 不会让中间态复活。
      s = chatReducer(s, { type: 'token', token: '案' });
      expect(s.searchProgress).toBeNull();
      expect(s.messages[1]?.content).toBe('答案');
    });

    it('非 streaming 态 tool_result 被忽略（迟到帧）', () => {
      const done = chatReducer(streamingState(), { type: 'done' });
      const next = chatReducer(done, { type: 'tool_result', count: 9 });
      expect(next).toBe(done);
    });

    it('sources 帧 → 挂到末尾 assistant 消息（[N]→源映射，FR-007）', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'token', token: '答案[1]' });
      s = chatReducer(s, {
        type: 'sources',
        sources: [
          { index: 1, title: 'A', url: 'https://a.com', publishedAt: 1700000000000 },
          { index: 2, title: 'B', url: 'https://b.com' },
        ],
      });
      expect(s.messages[1]?.sources).toEqual([
        { index: 1, title: 'A', url: 'https://a.com', publishedAt: 1700000000000 },
        { index: 2, title: 'B', url: 'https://b.com' },
      ]);
      // sources 落定后 done 不丢来源。
      const doneState = chatReducer(s, { type: 'done' });
      expect(doneState.messages[1]?.sources).toHaveLength(2);
      expect(doneState.messages[1]?.status).toBe('completed');
    });

    it('degraded 帧 → 末尾 assistant 消息标 degraded + 清中间态（FR-009 不丢消息）', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 2 });
      s = chatReducer(s, { type: 'degraded' });
      expect(s.messages[1]?.degraded).toBe(true);
      expect(s.searchProgress).toBeNull();
      // 降级后仍可继续作答（基于已有知识），消息不丢。
      s = chatReducer(s, { type: 'token', token: '基于已有知识' });
      expect(s.messages[1]?.content).toBe('基于已有知识');
    });

    it('🚨 abort（stopped）中断中间态：清 searchProgress', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 6 });
      expect(s.searchProgress).toBe(6);
      const next = chatReducer(s, { type: 'stopped' });
      expect(next.status).toBe('stopped');
      expect(next.searchProgress).toBeNull();
    });

    it('error 中断中间态：清 searchProgress', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 6 });
      const next = chatReducer(s, { type: 'error', message: 'boom' });
      expect(next.searchProgress).toBeNull();
    });

    it('多轮：第二轮 send 清掉上轮中间态', () => {
      let s = streamingState();
      s = chatReducer(s, { type: 'tool_result', count: 7 });
      s = chatReducer(s, { type: 'token', token: 'x' });
      const done = chatReducer(s, { type: 'done' });
      const next = chatReducer(done, { type: 'send', content: '下一问' });
      expect(next.searchProgress).toBeNull();
    });

    it('非 streaming 态 sources/degraded 被忽略（迟到帧）', () => {
      const done = chatReducer(streamingState(), { type: 'done' });
      expect(chatReducer(done, { type: 'sources', sources: [] })).toBe(done);
      expect(chatReducer(done, { type: 'degraded' })).toBe(done);
    });
  });
});
