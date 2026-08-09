// 034 T009 — 选择代码库纯逻辑单测（状态映射 Record 穷举 + meta 行装配 + 可选性）。
// 流 IO / 列表 render / 选中交互留 T012 e2e（per 测试分层 vitest=logic）。
import { describe, expect, it } from 'vitest';

import { REPO_STATUS_META, buildRepoMetaLine, type RepoCatalogEntry } from './repo-catalog.rules';

const NOW = '2026-06-23T12:00:00.000Z';

function entry(over: Partial<RepoCatalogEntry> = {}): RepoCatalogEntry {
  return {
    repo: 'no-vain-years-mono',
    lastSha: 'abc1234',
    indexedAt: '2026-06-23T11:00:00.000Z',
    chunkCount: 1280,
    status: 'ready',
    ...over,
  };
}

describe('REPO_STATUS_META (T009 状态映射穷举)', () => {
  it('ready / indexing 两态全覆盖（Record 穷举，漏成员编译红）', () => {
    expect(Object.keys(REPO_STATUS_META).sort()).toEqual(['indexing', 'ready']);
  });

  it('ready 可选、绿点；indexing 不可选、warn 点', () => {
    expect(REPO_STATUS_META.ready.selectable).toBe(true);
    expect(REPO_STATUS_META.ready.dotClass).toContain('ok');
    expect(REPO_STATUS_META.indexing.selectable).toBe(false);
    expect(REPO_STATUS_META.indexing.dotClass).toContain('warn');
  });
});

describe('buildRepoMetaLine (T009 meta 行装配)', () => {
  it('ready：相对索引时间 + chunk 数', () => {
    const line = buildRepoMetaLine(entry(), NOW);
    expect(line).toContain('1 小时前');
    expect(line).toContain('1280');
  });

  it('indexing：标索引中状态', () => {
    const line = buildRepoMetaLine(entry({ status: 'indexing' }), NOW);
    expect(line).toContain('索引中');
  });

  it('畸形 indexedAt 不崩（回退「刚刚」）', () => {
    const line = buildRepoMetaLine(entry({ indexedAt: 'not-a-date' }), NOW);
    expect(line).toContain('刚刚');
  });
});
