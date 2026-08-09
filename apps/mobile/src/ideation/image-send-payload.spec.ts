// 036 T014 — 仅附图直发 send payload 组装纯逻辑 vitest（FR-010）。
//
// 测试分层：本模块只组 image 入参（无 pin → 原图 ossKey + 文本，多图顺序与缩略条一致）；
// 上传 / 发送 / 渲染走 T015 e2e（US3 分支）。
import { describe, expect, it } from 'vitest';

import { buildImageOnlySendPayload } from './image-send-payload';

describe('buildImageOnlySendPayload — 仅附图直发 payload（无 pin 烧录）', () => {
  it('单图：attachmentKeys（原图 ossKey）+ previewUris，**无** annotationText', () => {
    const payload = buildImageOnlySendPayload(['ideation/42/a.webp'], ['file:///a.jpg']);
    expect(payload).toEqual({
      attachmentKeys: ['ideation/42/a.webp'],
      previewUris: ['file:///a.jpg'],
    });
    // 仅附图无 pin → 绝不带 annotationText（区别于 US1 标注烧录）。
    expect(payload).not.toHaveProperty('annotationText');
  });

  it('多图：顺序与缩略条一致（FR-010，原样保留 keys / uris 顺序）', () => {
    const keys = ['ideation/42/a.webp', 'ideation/42/b.webp', 'ideation/42/c.webp'];
    const uris = ['file:///a.jpg', 'file:///b.jpg', 'file:///c.jpg'];
    const payload = buildImageOnlySendPayload(keys, uris);
    expect(payload?.attachmentKeys).toEqual(keys); // 不重排。
    expect(payload?.previewUris).toEqual(uris); // 同序。
  });

  it('空 attachmentKeys → undefined（退化纯文本轮，行为零回归）', () => {
    expect(buildImageOnlySendPayload([], [])).toBeUndefined();
    expect(buildImageOnlySendPayload([], ['file:///orphan.jpg'])).toBeUndefined();
  });
});
