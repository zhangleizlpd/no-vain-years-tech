// 030 T014 — 来源 URL scheme 校验纯逻辑单测（FR-005 防注入）。组件 render / tap 打开留
// T015 e2e（per 测试分层 vitest=logic·Playwright=UI）。
import { describe, expect, it } from 'vitest';
import { isSafeHttpUrl } from './web-search-url';
import { CHAT_COPY } from './chat-copy';

describe('isSafeHttpUrl (FR-005 来源打开 scheme 校验防注入)', () => {
  it('https → 放行', () => {
    expect(isSafeHttpUrl('https://example.com/a/b?q=1')).toBe(true);
  });

  it('http → 放行', () => {
    expect(isSafeHttpUrl('http://example.com')).toBe(true);
  });

  it('javascript: → 拒（防脚本注入）', () => {
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
  });

  it('file: → 拒（防本地文件读取）', () => {
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
  });

  it('data: → 拒', () => {
    expect(isSafeHttpUrl('data:text/html,<script>1</script>')).toBe(false);
  });

  it('非法 / 无 scheme 串 → 拒（URL 构造抛错兜底）', () => {
    expect(isSafeHttpUrl('not a url')).toBe(false);
    expect(isSafeHttpUrl('')).toBe(false);
    expect(isSafeHttpUrl('example.com')).toBe(false);
  });

  it('大小写 scheme（HTTPS）→ URL 归一化后放行', () => {
    expect(isSafeHttpUrl('HTTPS://example.com')).toBe(true);
  });
});

describe('030 文案常量（中间态 / 来源 / 降级）', () => {
  it('中间态前后缀拼成「已阅读 N 个网页」', () => {
    expect(`${CHAT_COPY.searchProgressPrefix}3${CHAT_COPY.searchProgressSuffix}`).toBe(
      '已阅读 3 个网页',
    );
  });

  it('来源折叠头拼成「N 个网页来源」', () => {
    expect(`5${CHAT_COPY.sourcesHeaderSuffix}`).toBe('5 个网页来源');
  });

  it('降级标识文案', () => {
    expect(CHAT_COPY.degradedNotice).toBe('本次未联网，基于已有知识作答');
  });
});
