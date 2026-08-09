import { describe, expect, it } from 'vitest';

import { ossThumbCacheKey, ossThumbUrl } from './oss-image';

const BASE = 'https://mbw-profile-images.oss-cn-shanghai.aliyuncs.com/avatar/1/uuid/img';

describe('ossThumbUrl', () => {
  it('append x-oss-process resize + webp + quality（无 query 用 ?）', () => {
    expect(ossThumbUrl(BASE, { width: 200, height: 200 })).toBe(
      `${BASE}?x-oss-process=image/resize,m_lfit,w_200,h_200/format,webp/quality,q_80`,
    );
  });

  it('已带 query 的 URL 用 & 续接', () => {
    expect(ossThumbUrl(`${BASE}?v=1`, { width: 64, height: 64 })).toContain('&x-oss-process=');
  });
});

describe('ossThumbCacheKey', () => {
  it('按 (URL, 尺寸) 分桶 —— 不同尺寸键不同、换 URL 键变', () => {
    expect(ossThumbCacheKey(BASE, { width: 200, height: 200 })).toBe(`${BASE}@200x200`);
    expect(ossThumbCacheKey(BASE, { width: 64, height: 64 })).not.toBe(
      ossThumbCacheKey(BASE, { width: 200, height: 200 }),
    );
  });
});
