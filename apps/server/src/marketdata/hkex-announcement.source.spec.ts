import { describe, expect, it } from 'vitest';

import { parseHkexFileNumber } from './hkex-announcement.source.js';

// FR-031 (spec Session（十）)：港交所文件编号只作「同一份文件」的身份标识, 编号日期只用来界定同编号行的查找区间。
describe('parseHkexFileNumber — 公告链接 → 港交所文件编号与编号日期', () => {
  it.each([
    [
      '主板 PDF (hk:02333 重挂路径)',
      'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/0331/2025032804889_c.pdf',
      '2025032804889',
      '2025-03-28',
    ],
    [
      '创业板',
      'https://www1.hkexnews.hk/listedco/listconews/gem/2026/1009/2026100900956_c.pdf',
      '2026100900956',
      '2026-10-09',
    ],
    [
      '非 PDF 附件',
      'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0327/2026032704293_c.xlsx',
      '2026032704293',
      '2026-03-27',
    ],
    [
      '英文版',
      'https://www1.hkexnews.hk/listedco/listconews/sehk/2026/0922/2026092101560.pdf',
      '2026092101560',
      '2026-09-21',
    ],
  ])('%s: %s ⇒ 编号 %s / 编号日期 %s', (_label, url, fileNumber, date) => {
    expect(parseHkexFileNumber(url)).toEqual({ fileNumber, date });
  });

  it.each([
    [
      '旧式编号 (sehkYYMMDD…)',
      'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/1205/sehk25101500968_c.pdf',
    ],
    ['披露易目录页', 'https://www1.hkexnews.hk/listedco/listconews/sehk/dod/tc.html'],
    [
      '编号日期非法 (13 月)',
      'https://www1.hkexnews.hk/listedco/listconews/sehk/2025/1305/2025130504889_c.pdf',
    ],
    ['非港交所链接', 'https://example.test/1/2.pdf'],
  ])('%s ⇒ null (调用方按行日期)', (_label, url) => {
    expect(parseHkexFileNumber(url)).toBeNull();
  });
});
