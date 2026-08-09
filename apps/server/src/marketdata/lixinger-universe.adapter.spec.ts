import { describe, it, expect, vi } from 'vitest';
import { LixingerUniverseAdapter, listingStatusToStatus } from './lixinger-universe.adapter.js';
import type { VendorHttpClient, VendorRequest } from './vendor-http-client.js';

/**
 * 理杏仁 universe adapter mock 单测。验 `/cn/company` 不带 stockCodes 全集枚举 → canonical
 * `cn:code` + listingStatus 原值透传 + status allowlist 归一 + ipoDate→listDate + 容错 + 去重。
 * listingStatus 取值域由 runbook `lixinger-enum` 探针实测 (2026-06-03, 9 值谱系)。
 */
const TOKEN = 'test-token';
const BASE = 'https://open.lixinger.com/api';

type Payload = unknown[] | { code?: number; message?: string; data?: unknown };

/**
 * fake http: 按 market 段路由 (038 T008 adapter 多市场枚举 /cn/company + /hk/company)。
 * `/hk/` 请求返 hkPayload (默认空 = cn-only 旧断言无回归); 其余返 cnPayload。
 */
function makeHttp(
  cnPayload: Payload,
  hkPayload: Payload = [],
): {
  http: VendorHttpClient;
  calls: VendorRequest[];
} {
  const toEnvelope = (p: Payload) =>
    Array.isArray(p) ? { code: 1, message: 'success', data: p } : p;
  const cnEnv = toEnvelope(cnPayload);
  const hkEnv = toEnvelope(hkPayload);
  const calls: VendorRequest[] = [];
  const request = vi.fn(async (req: VendorRequest) => {
    calls.push(req);
    return req.url.includes('/hk/') ? hkEnv : cnEnv;
  });
  return { http: { request } as unknown as VendorHttpClient, calls };
}

function bodyOf(req: VendorRequest): Record<string, unknown> {
  return JSON.parse(req.body ?? '{}') as Record<string, unknown>;
}

describe('listingStatusToStatus (allowlist 归一)', () => {
  it('4 个可交易值 (含 ST/*ST/退市整理期) → active', () => {
    for (const s of [
      'normally_listed',
      'special_treatment',
      'delisting_risk_warning',
      'delisting_transitional_period',
    ]) {
      expect(listingStatusToStatus(s)).toBe('active');
    }
  });

  it('暂停/未上市/发行失败/未知值/null → inactive (allowlist fail-safe)', () => {
    for (const s of [
      'ipo_suspension',
      'issued_but_not_listed',
      'issue_failure',
      'unauthorized',
      'some_future_unknown_status',
    ]) {
      expect(listingStatusToStatus(s)).toBe('inactive');
    }
    expect(listingStatusToStatus(null)).toBe('inactive');
  });
});

describe('LixingerUniverseAdapter', () => {
  it('/cn/company 行 → {market:cn, code, name, status, listingStatus, listDate}; POST 不带 stockCodes', async () => {
    const { http, calls } = makeHttp([
      {
        stockCode: '600519',
        name: '贵州茅台',
        listingStatus: 'normally_listed',
        ipoDate: '2001-08-27T00:00:00+08:00',
      },
      {
        stockCode: '688646',
        name: 'ST逸飞',
        listingStatus: 'special_treatment',
        ipoDate: '2023-07-28T00:00:00+08:00',
      }, // ST 仍 active
      { stockCode: '002710', name: '慈铭体检', listingStatus: 'ipo_suspension', ipoDate: null }, // 暂停 → inactive
    ]);
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);

    expect(out).toEqual([
      {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        status: 'active',
        listingStatus: 'normally_listed',
        listDate: '2001-08-27',
      },
      {
        market: 'cn',
        code: '688646',
        name: 'ST逸飞',
        status: 'active',
        listingStatus: 'special_treatment',
        listDate: '2023-07-28',
      },
      {
        market: 'cn',
        code: '002710',
        name: '慈铭体检',
        status: 'inactive',
        listingStatus: 'ipo_suspension',
        listDate: null,
      },
    ]);
    expect(calls[0].method).toBe('POST');
    expect(calls[0].url).toContain(`${BASE}/cn/company`);
    const body = bodyOf(calls[0]);
    expect(body.token).toBe(TOKEN);
    expect(body.stockCodes).toBeUndefined(); // 不带 stockCodes = 全集
  });

  it('listingStatus 缺失 → status inactive + listingStatus null (allowlist fail-safe)', async () => {
    const { http } = makeHttp([{ stockCode: '000991', name: '通海高科' }]); // 无 listingStatus 字段
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);
    expect(out).toEqual([
      {
        market: 'cn',
        code: '000991',
        name: '通海高科',
        status: 'inactive',
        listingStatus: null,
        listDate: null,
      },
    ]);
  });

  it('容错: 缺 stockCode / name 坏项跳过, 不整体失败', async () => {
    const { http } = makeHttp([
      { stockCode: '600519', name: '贵州茅台', listingStatus: 'normally_listed' },
      { stockCode: '', name: '空代码' }, // 跳过
      { stockCode: '000002', name: '' }, // 跳过
      { name: '无代码' }, // 跳过
    ]);
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);
    expect(out).toEqual([
      {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        status: 'active',
        listingStatus: 'normally_listed',
        listDate: null,
      },
    ]);
  });

  it('canonical 去重 (同 code 重复 → 收一次)', async () => {
    const { http } = makeHttp([
      { stockCode: '600519', name: '贵州茅台', listingStatus: 'normally_listed' },
      { stockCode: '600519', name: '贵州茅台', listingStatus: 'normally_listed' },
    ]);
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);
    expect(out).toEqual([
      {
        market: 'cn',
        code: '600519',
        name: '贵州茅台',
        status: 'active',
        listingStatus: 'normally_listed',
        listDate: null,
      },
    ]);
  });

  it('空 data → 空数组 (非 error)', async () => {
    const { http } = makeHttp([]);
    expect(await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk'])).toEqual(
      [],
    );
  });

  it('应用层错 (非数组 data / 无效 token) → base 抛错 (交 FallbackChain 平移)', async () => {
    const { http } = makeHttp({ code: 0, message: 'invalid token', data: null });
    await expect(
      new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn']),
    ).rejects.toThrow();
  });

  // 038 T008: adapter 多市场枚举 (/cn/company + /hk/company) → cn+hk 双市场 canonical。
  it('cn+hk 双市场枚举: hk/company 行 → {market:hk, ...}; cn 无回归; 两次 POST', async () => {
    const { http, calls } = makeHttp(
      [{ stockCode: '600519', name: '贵州茅台', listingStatus: 'normally_listed' }], // cn
      [
        {
          stockCode: '00700',
          name: '腾讯控股',
          listingStatus: 'normally_listed',
          ipoDate: '2004-06-16T00:00:00+08:00',
        },
        { stockCode: '00823', name: '领展房产基金', listingStatus: 'normally_listed' }, // REIT
      ], // hk
    );
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);

    expect(out.find((e) => e.code === '600519')?.market).toBe('cn'); // cn 无回归
    expect(out).toContainEqual({
      market: 'hk',
      code: '00700',
      name: '腾讯控股',
      status: 'active',
      listingStatus: 'normally_listed',
      listDate: '2004-06-16',
    });
    expect(out).toContainEqual({
      market: 'hk',
      code: '00823',
      name: '领展房产基金',
      status: 'active',
      listingStatus: 'normally_listed',
      listDate: null,
    });
    expect(calls.some((c) => c.url.includes('/cn/company'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/hk/company'))).toBe(true);
  });

  // 038 T008 (P1 保守映射): hk 未知/退市 listingStatus → inactive (active-only 过滤) + 原值存档。
  it('hk 退市/未知 listingStatus → inactive (allowlist fail-safe, active-only) + listingStatus 原值存档', async () => {
    const { http } = makeHttp(
      [], // cn 空
      [
        { stockCode: '00700', name: '腾讯控股', listingStatus: 'normally_listed' },
        { stockCode: '01234', name: '某退市港股', listingStatus: 'some_hk_delisted_status' }, // 未知 → inactive
      ],
    );
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);

    expect(out.find((e) => e.code === '00700')?.status).toBe('active');
    const delisted = out.find((e) => e.code === '01234');
    expect(delisted?.status).toBe('inactive'); // 保守: 非明确可交易 → 不纳入工作集
    expect(delisted?.listingStatus).toBe('some_hk_delisted_status'); // 原值存档 (审计/改映射不重 sync)
  });

  // 038 T008 fail-soft: hk 枚举失败不拖累 cn (cn 已得 → 返 cn, 不整体抛; 全失败才抛)。
  it('hk 源失败但 cn 成功 → 返 cn 结果不抛 (fail-soft, hk 失败不连坐 cn)', async () => {
    const { http } = makeHttp(
      [{ stockCode: '600519', name: '贵州茅台', listingStatus: 'normally_listed' }], // cn 成功
      { code: 0, message: 'hk vendor error', data: null }, // hk 应用层错
    );
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['cn', 'hk']);
    expect(out.map((e) => e.code)).toEqual(['600519']); // cn 保留, hk 失败静默 (fail-soft)
  });

  // S2-T2: 理杏仁无 us — enumerate(['us']) 交集 ENUMERATED_MARKETS(cn/hk) 为空 → 零外呼返空
  // (交 FallbackChain 平移东财备源接 us)。
  it('enumerate(["us"]) → 空集不外呼返空 (理杏仁无 us; per-market ∩ 支持市场)', async () => {
    const { http, calls } = makeHttp([{ stockCode: '600519', name: '贵州茅台' }]);
    const out = await new LixingerUniverseAdapter(http, TOKEN, BASE).enumerate(['us']);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0); // 无 cn/hk 命中 → 零 POST
  });
});
