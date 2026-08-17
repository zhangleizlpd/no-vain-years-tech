// 061 T014 — 「数据截至」标注的**粒度**单测（FR-009）。
//
// 本片的呈现契约只有一条：**档位不上屏，只以 asOf 的粒度表达它** —— 实时档呈时刻、
// 收盘档呈交易日。所以这里断言的是「粒度对不对」，不是「有没有一个叫实时的标记」；
// 任何形如 `· 实时` 的后缀都会让 Guardrail 18 失守，故有一条反向断言盯着它。
//
// 🚨 时区纪律：实时时刻按**设备本地**呈现（同 `~/alert` 的 `n()` 体例）—— 境内用户盯美股
//    盘中，读到的必须是自己表上的钟点。这与 `~/format/datetime` 刻意选 UTC 不同：那个是
//    「上次活跃」这类跨端比对的绝对时刻，本函数是给人看的墙钟。
//    ⇒ 取值断言一律用**无偏移**的 ISO 串（`new Date` 按本地解析 ⇒ 结果与运行时区无关）；
//    带 `Z` 的串只断言**形状**与**相对差**，不断言具体钟点。
import { describe, expect, it } from 'vitest';

import { formatAsOfLabel, todayYmd } from './as-of';

describe('formatAsOfLabel — 收盘档呈交易日（既有语义，防回归）', () => {
  it('eod_close → 「数据截至 <交易日> · 收盘」', () => {
    expect(formatAsOfLabel('2026-08-17', 'eod_close')).toBe('数据截至 2026-08-17 · 收盘');
  });

  it('未给档位 → 只有日期，不擅自说「收盘」', () => {
    expect(formatAsOfLabel('2026-08-17')).toBe('数据截至 2026-08-17');
  });

  it('asOf 缺失 → 空串（调用方据此不渲染，绝不渲染裸数值）', () => {
    expect(formatAsOfLabel(null, 'eod_close')).toBe('');
    expect(formatAsOfLabel(undefined)).toBe('');
    expect(formatAsOfLabel('', 'realtime')).toBe('');
  });
});

describe('formatAsOfLabel — 实时档呈时刻（FR-009 新增）', () => {
  it('realtime → 「数据截至 HH:mm」，日期不出现（粒度即档位）', () => {
    expect(formatAsOfLabel('2026-08-17T13:22:31', 'realtime')).toBe('数据截至 13:22');
    expect(formatAsOfLabel('2026-08-17T09:05:00', 'realtime')).toBe('数据截至 09:05');
  });

  it('🚨 Guardrail 18：实时档 MUST NOT 带任何档位后缀（「· 收盘」也不许张冠李戴）', () => {
    const label = formatAsOfLabel('2026-08-17T13:22:31', 'realtime');
    expect(label).not.toContain('收盘');
    expect(label).not.toContain('实时');
    expect(label).not.toContain('realtime');
  });

  it('带时区偏移的 ISO 串也归到时刻粒度，且相差一小时的两个时刻钟点差一小时', () => {
    const early = formatAsOfLabel('2026-08-17T13:22:31.000Z', 'realtime');
    const late = formatAsOfLabel('2026-08-17T14:22:31.000Z', 'realtime');
    expect(early).toMatch(/^数据截至 \d{2}:\d{2}$/);
    expect(late).toMatch(/^数据截至 \d{2}:\d{2}$/);
    const hourOf = (s: string) => Number.parseInt(s.slice(-5, -3), 10);
    expect((hourOf(late) - hourOf(early) + 24) % 24).toBe(1);
    // 分钟不受时区影响（整点偏移的时区下恒等；半点偏移时区仍同为 22 分）。
    expect(early.slice(-2)).toBe(late.slice(-2));
  });

  it('实时档的非法时间串 → 空串（宁可不渲染，不渲染 NaN:NaN）', () => {
    expect(formatAsOfLabel('not-a-date', 'realtime')).toBe('');
  });
});

describe('todayYmd — 设备本地日历日（既有语义，防回归）', () => {
  it('按本地年月日拼 `YYYY-MM-DD`', () => {
    expect(todayYmd(new Date(2026, 7, 3, 9, 30))).toBe('2026-08-03');
  });
});
