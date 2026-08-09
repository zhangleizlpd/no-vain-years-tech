// 032 T018 — 会话列表纯逻辑单测（列表准备 / 徽标映射穷举 / 相对时间）。
import { describe, expect, it } from 'vitest';

import { STATUS_BADGE_META, type IdeationSessionStatus } from './brief-view.rules';
import { prepareSessionList, relativeUpdatedAt, type SessionListItem } from './session-list.rules';

const item = (over: Partial<SessionListItem> = {}): SessionListItem => ({
  id: '1',
  title: '会话',
  status: 'open',
  updatedAt: '2026-06-22T00:00:00.000Z',
  ...over,
});

describe('prepareSessionList', () => {
  it('按 updatedAt 倒序兜底排序（server 偶发乱序防御）', () => {
    const rows = prepareSessionList([
      item({ id: 'a', updatedAt: '2026-06-20T00:00:00.000Z' }),
      item({ id: 'b', updatedAt: '2026-06-22T00:00:00.000Z' }),
      item({ id: 'c', updatedAt: '2026-06-21T00:00:00.000Z' }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('每行附带收敛状态 + 徽标元数据', () => {
    const rows = prepareSessionList([item({ status: 'converged' })]);
    expect(rows[0]?.status).toBe('converged');
    expect(rows[0]?.badge).toEqual(STATUS_BADGE_META.converged);
  });

  it('宽松/未知 status 兜底 open（normalizeStatus）', () => {
    const rows = prepareSessionList([item({ status: 'WEIRD' })]);
    expect(rows[0]?.status).toBe('open');
    expect(rows[0]?.badge).toEqual(STATUS_BADGE_META.open);
  });

  it('空列表 → 空数组', () => {
    expect(prepareSessionList([])).toEqual([]);
  });

  it('不修改入参数组', () => {
    const input = [item({ id: 'x' }), item({ id: 'y' })];
    const snapshot = input.map((i) => i.id);
    prepareSessionList(input);
    expect(input.map((i) => i.id)).toEqual(snapshot);
  });

  // 徽标映射穷举：三状态全覆盖（漏 enum 成员 STATUS_BADGE_META 编译红已兜底，此处运行时再证）。
  it.each<IdeationSessionStatus>(['open', 'converged', 'handed-off'])(
    '状态 %s 映射到对应徽标 label/tone',
    (status) => {
      const rows = prepareSessionList([item({ status })]);
      expect(rows[0]?.badge.label).toBe(STATUS_BADGE_META[status].label);
      expect(rows[0]?.badge.tone).toBe(STATUS_BADGE_META[status].tone);
    },
  );
});

describe('relativeUpdatedAt', () => {
  const now = '2026-06-22T12:00:00.000Z';

  it('< 1 分钟 → 刚刚', () => {
    expect(relativeUpdatedAt('2026-06-22T11:59:30.000Z', now)).toBe('刚刚');
  });

  it('< 1 小时 → N 分钟前', () => {
    expect(relativeUpdatedAt('2026-06-22T11:30:00.000Z', now)).toBe('30 分钟前');
  });

  it('< 1 天 → N 小时前', () => {
    expect(relativeUpdatedAt('2026-06-22T09:00:00.000Z', now)).toBe('3 小时前');
  });

  it('< 30 天 → N 天前', () => {
    expect(relativeUpdatedAt('2026-06-17T12:00:00.000Z', now)).toBe('5 天前');
  });

  it('≥ 30 天 → YYYY-MM-DD', () => {
    expect(relativeUpdatedAt('2026-01-05T12:00:00.000Z', now)).toBe('2026-01-05');
  });

  it('未来时间（时钟偏差）→ 刚刚', () => {
    expect(relativeUpdatedAt('2026-06-22T13:00:00.000Z', now)).toBe('刚刚');
  });

  it('非法串 → 刚刚', () => {
    expect(relativeUpdatedAt('not-a-date', now)).toBe('刚刚');
  });
});
