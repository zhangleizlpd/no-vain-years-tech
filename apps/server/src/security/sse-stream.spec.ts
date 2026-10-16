import { EventEmitter } from 'node:events';
import { describe, it, expect, vi } from 'vitest';
import type { FastifyReply } from 'fastify';
import { openLazySseStream, pickCorsHeaders } from './sse-stream';

/** 只模拟 helper 用到的 reply 面: getHeaders / hijack / raw.{on,writeHead,write,end}。 */
function fakeReply(headers: Record<string, number | string | string[] | undefined> = {}) {
  const raw = Object.assign(new EventEmitter(), {
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  });
  const reply = { getHeaders: () => headers, hijack: vi.fn(), raw };
  return { reply: reply as unknown as FastifyReply, hijack: reply.hijack, raw };
}

describe('pickCorsHeaders', () => {
  it('只挑 access-control-* 与 vary (大小写不敏感), 跳过 undefined', () => {
    expect(
      pickCorsHeaders({
        'Access-Control-Allow-Origin': 'https://a.example',
        'access-control-allow-credentials': 'true',
        Vary: 'Origin',
        'content-type': 'application/json',
        'access-control-expose-headers': undefined,
      }),
    ).toEqual({
      'Access-Control-Allow-Origin': 'https://a.example',
      'access-control-allow-credentials': 'true',
      Vary: 'Origin',
    });
  });
});

describe('openLazySseStream', () => {
  it('首帧前不 hijack (前置校验异常仍可交回 Nest 过滤器)', () => {
    const { reply, hijack, raw } = fakeReply();
    const stream = openLazySseStream(reply);
    expect(stream.started).toBe(false);
    expect(hijack).not.toHaveBeenCalled();
    expect(raw.writeHead).not.toHaveBeenCalled();
  });

  it('首帧: hijack 一次 + writeHead 带 SSE 头与 cors 头; 后续帧不重复 writeHead', () => {
    const { reply, hijack, raw } = fakeReply({
      'access-control-allow-origin': 'https://a.example',
    });
    const stream = openLazySseStream(reply);
    stream.write('data:1\n\n');
    stream.write('data:2\n\n');
    expect(stream.started).toBe(true);
    expect(hijack).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledOnce();
    expect(raw.writeHead).toHaveBeenCalledWith(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'access-control-allow-origin': 'https://a.example',
    });
    expect(raw.write.mock.calls.map((c) => c[0])).toEqual(['data:1\n\n', 'data:2\n\n']);
  });

  it('end(): 未开流也先 hijack 再写末帧 + end', () => {
    const { reply, hijack, raw } = fakeReply();
    const stream = openLazySseStream(reply);
    stream.end('data:[DONE]\n\n');
    expect(hijack).toHaveBeenCalledOnce();
    expect(raw.write).toHaveBeenCalledWith('data:[DONE]\n\n');
    expect(raw.end).toHaveBeenCalledOnce();
  });

  it('end() 前连接 close → abort 上游 (客户端断连 / 主动停止)', () => {
    const { reply, raw } = fakeReply();
    const stream = openLazySseStream(reply);
    stream.write('data:1\n\n');
    raw.emit('close');
    expect(stream.signal.aborted).toBe(true);
  });

  it('end() 之后的 close 不算 stop, 不 abort', () => {
    const { reply, raw } = fakeReply();
    const stream = openLazySseStream(reply);
    stream.end('data:[DONE]\n\n');
    raw.emit('close');
    expect(stream.signal.aborted).toBe(false);
  });
});
