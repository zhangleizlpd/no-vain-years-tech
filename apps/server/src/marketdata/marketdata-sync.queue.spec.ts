import { describe, it, expect } from 'vitest';
import {
  DEFAULT_QUEUE_LANE,
  MARKETDATA_SYNC_FUTU_QUEUE,
  MARKETDATA_SYNC_QUEUE,
  QUEUE_LANES,
  queueNameForLane,
  resolveQueueLane,
  type QueueLane,
} from './marketdata-sync.queue.js';

describe('resolveQueueLane (issue #210 vendor lane)', () => {
  describe('灰度 flag 关 = 拆 lane 前的行为', () => {
    // 🚨 这一组是**回滚开关的语义本身**: flag 关时无论 DB 里那一列填了什么, 一律 default。
    // 少了它, 「回滚 = 翻 flag」这句话就没有机器背书。
    it.each([...QUEUE_LANES, 'futu', 'typo', '', null, undefined])(
      'rawLane=%s 且 enabled=false ⇒ default',
      (raw) => {
        expect(resolveQueueLane(raw as string | null | undefined, false)).toBe('default');
      },
    );
  });

  describe('灰度 flag 开', () => {
    it('登记过的 lane 原样生效', () => {
      expect(resolveQueueLane('futu', true)).toBe('futu');
      expect(resolveQueueLane('default', true)).toBe('default');
    });

    // 🚨 不可识别的值**收敛到 default 而不是抛**: 抛会让一个打错字的 lane 值在 tick 里炸掉
    // 整轮组 flow (`tick()` 把异常吞成 ERROR log, 而告警无接收方 ⇒ 整夜静默瘫痪)。
    it.each(['FUTU', 'futu ', 'lixinger', 'typo', ''])(
      '不可识别的 rawLane=%s ⇒ 落回 default 且不抛',
      (raw) => {
        expect(() => resolveQueueLane(raw, true)).not.toThrow();
        expect(resolveQueueLane(raw, true)).toBe('default');
      },
    );

    it.each([null, undefined])('rawLane=%s (列缺失) ⇒ 落回 default', (raw) => {
      expect(resolveQueueLane(raw, true)).toBe('default');
    });
  });
});

describe('queueNameForLane', () => {
  it('两条 lane 各自映射到不同的 queue', () => {
    expect(queueNameForLane('default')).toBe(MARKETDATA_SYNC_QUEUE);
    expect(queueNameForLane('futu')).toBe(MARKETDATA_SYNC_FUTU_QUEUE);
  });

  // default lane 的 queue 名保持 `marketdata-sync` 不变是刻意的: 灰度 flag 关时 Redis 里
  // 不出现任何新 key, 回滚才是真的「什么都没发生」。
  it('default lane 的 queue 名 = 拆 lane 前那一个', () => {
    expect(queueNameForLane(DEFAULT_QUEUE_LANE)).toBe('marketdata-sync');
  });

  it('lane 值域内每条都有 queue 名, 且互不相同', () => {
    const names = QUEUE_LANES.map((lane: QueueLane) => queueNameForLane(lane));
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(new Set(names).size).toBe(QUEUE_LANES.length);
  });
});
