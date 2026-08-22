/**
 * 045 optionsdesk 契约冒烟（Constitution §V 两层验证之二）。
 *
 * 用**生成的** @nvy/api-client 打 harness boot 的**真 server**（testcontainers PG），跑一条
 * happy-path：**建锚 → 读雷达 → 改 L 层 → 撤销**，验两件 hermetic mock 与 server IT 都盖不到的事：
 *   ① **契约对齐** —— URL / method / 查询串序列化 / 响应解封 / 错误码，全走消费端真实代码路径；
 *   ② **真落库** —— 写完从**另一个端点**读回（radar / list），证数据穿过了真 Prisma + 真 PG。
 *
 * 🚨 本 spec 的最后一步「撤销」正是 T022 被迫做收窄 cast 的那处契约缺口所在：
 *    `UpdateAnchorRequest.lLevelManual` 曾生成为**非 nullable** enum（server DTO 是
 *    `LLevel | null`，`null` 就是「撤销」的语义，swagger 装饰器少了 `nullable: true`）。
 *    T026 已补 `nullable: true` → 重跑 export-openapi → regen → 拆掉那处 cast；下面
 *    `lLevelManual: null` 直接过类型**就是**这条契约修复的机械回归探针。
 *
 * ⚠️ 三处人工位已逐一核对：`vManual` / `positionCapManual` 的 `nullable: true` 本就在，
 *    只有 `lLevelManual` 漏了。本 spec 三处撤销都断言，防将来任一处再退化。
 *
 * 边界与幂等：用专属 ticker（避开其他 spec 与 mock fixture），末尾 DELETE 自清理 ——
 * 同一次 boot 内顺序跑多 spec 不互相污染。
 */
import assert from 'node:assert/strict';
import axios from 'axios';
import {
  optionsdeskControllerCreate,
  optionsdeskControllerList,
  optionsdeskControllerRadar,
  optionsdeskControllerRemove,
  optionsdeskControllerUpdate,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'optionsdesk-anchors-radar (045)';

/** 专属 ticker（canonical `market:code`）—— 不与 marketdata contract 的 cn:600599 撞。 */
const TICKER = 'us:NVYX';
/** confidence 8.0 → 映射档 L2（anchor.rules：≥9 L1 / 7–9 L2 / 3–7 L3 / <3 L4）。 */
const CONFIDENCE = '8.0';
const V = '100.0000';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };

  // ── ① 建锚 → 201 + 同响应带全部派生值（W / 四区间 / L 层 / 单票上限 / 愿卖锚）─────────
  const created = await optionsdeskControllerCreate(
    {
      ticker: TICKER,
      v: V,
      asof: '2026-07-01',
      method: 'DCF · 契约冒烟',
      confidence: CONFIDENCE,
      nextReview: '2026-12-31',
    },
    cfg,
  );
  assert.equal(created.status, 201, `create expected 201, got ${created.status}`);
  const anchorId = created.data.id;
  assert.ok(anchorId, 'created anchor carries id');

  try {
    assert.equal(created.data.ticker, TICKER);
    // 派生链：W = 0.8V；四区间 0.6V / W / V / 1.2V；confidence 8.0 → L2。
    assert.equal(Number(created.data.w), Number(V) * 0.8, 'W = 0.8V');
    assert.equal(Number(created.data.zoneFloor), Number(V) * 0.6, '四区间下界 = 0.6V');
    assert.equal(Number(created.data.zoneCeiling), Number(V) * 1.2, '四区间上界 = 1.2V');
    assert.equal(created.data.lLevelEffective, 'L2', 'confidence 8.0 → 映射档 L2');
    assert.equal(created.data.derivedLLevel, 'L2');
    // 建锚即三处人工位全空（系统不代为设置，FR-032 ①）。
    assert.equal(created.data.vIsManual, false);
    assert.equal(created.data.lLevelIsManual, false);
    assert.equal(created.data.positionCapIsManual, false);

    // ── ② 读雷达 → 新锚真落库、从**另一个端点**读得回 ────────────────────────────
    // 查询串序列化在这里一并验：`lLevels` 走重复键（axios 默认的 `lLevels[]=` 形态 Fastify
    // 的 querystring parser 不认，会静默滤空），故与 mobile 的 useRadar 同样钉 indexes:null。
    const radar = await optionsdeskControllerRadar(
      { limit: 50, market: 'us', lLevels: ['L1', 'L2'] },
      { ...cfg, paramsSerializer: { indexes: null } },
    );
    assert.equal(radar.status, 200, `radar expected 200, got ${radar.status}`);
    const onRadar = radar.data.items.find((a) => a.id === anchorId);
    assert.ok(onRadar, '新锚出现在雷达（真 DB round-trip + L2 筛选命中）');
    assert.equal(onRadar?.ticker, TICKER);
    // 行情未采集 ⇒ 数值与 asOf **同生共死**（SC-004：禁裸数值 / 禁 0 值）。
    assert.equal(onRadar?.lastCloseDate, null, '未采集 ⇒ lastCloseDate = null');
    assert.equal(onRadar?.lastClose, null, 'lastCloseDate 缺 ⇒ lastClose 必须也是 null');
    assert.equal(onRadar?.zone, null, '无 spot ⇒ 不伪造区间');
    // 筛选真的到了 SQL 端：把 L 档换成不含 L2 的集合，本锚应落出结果集。
    const radarL1 = await optionsdeskControllerRadar(
      { limit: 50, market: 'us', lLevels: ['L1'] },
      { ...cfg, paramsSerializer: { indexes: null } },
    );
    assert.ok(
      !radarL1.data.items.some((a) => a.id === anchorId),
      'lLevels=L1 筛选真到 SQL 端（L2 的锚被滤掉，不是前端过的）',
    );

    // ── ②b SC-003：两个市场作用域的并集 = 不带作用域时的全集，交集为空 ──────────
    // 🚨 这是 SC-003 唯一的**端到端**落点（IT 层只到 use case）。`market` 在契约里是**可选**
    //    参数 ⇒ 不显式带上的话，生成的 client 与真 server 在这个新参数上的对齐**从未被验证过**
    //    ——「绿但零覆盖」。
    const [all, onlyUs, onlyHk] = await Promise.all([
      optionsdeskControllerRadar({ limit: 100 }, cfg),
      optionsdeskControllerRadar({ limit: 100, market: 'us' }, cfg),
      optionsdeskControllerRadar({ limit: 100, market: 'hk' }, cfg),
    ]);
    for (const [name, res] of [
      ['all', all],
      ['us', onlyUs],
      ['hk', onlyHk],
    ] as const) {
      assert.equal(res.status, 200, `radar(${name}) expected 200, got ${res.status}`);
    }
    // 前提：全集要在一页内，否则「并集 = 全集」比的是两个被截断的集合。锚数超 100 时这条会
    // 明确红出来（而不是静默失真）。
    assert.equal(all.data.hasMore, false, 'SC-003 并集断言的前提：全集在一页内');

    const idsOf = (res: typeof all): string[] => res.data.items.map((a) => a.id).sort();
    const usIds = idsOf(onlyUs);
    const hkIds = idsOf(onlyHk);
    assert.deepEqual(
      [...usIds, ...hkIds].sort(),
      idsOf(all),
      'SC-003 并集 = 全部锚（无遗漏：每只锚都落在某个页签里）',
    );
    assert.equal(
      usIds.filter((id) => hkIds.includes(id)).length,
      0,
      'SC-003 交集为空（无重复：没有锚同时出现在两个页签）',
    );
    // 作用域的纯净性：各自只回本市场的行（列相等谓词真到了 SQL 端）。
    assert.ok(
      onlyUs.data.items.every((a) => a.ticker.startsWith('us:')),
      'us 作用域只回 us 行',
    );
    assert.ok(
      onlyHk.data.items.every((a) => a.ticker.startsWith('hk:')),
      'hk 作用域只回 hk 行',
    );
    // FR-016：多市场计数随响应下发，且**不受本次作用域限制**（小圆点的数据源）。
    assert.ok(
      Array.isArray(onlyUs.data.marketCounts),
      'marketCounts 是数组（不是 map —— 后者会让 orval 生成 objectmap）',
    );
    assert.deepEqual(
      onlyUs.data.marketCounts.map((c) => c.market).sort(),
      all.data.marketCounts.map((c) => c.market).sort(),
      'marketCounts 不随作用域收窄（否则港股有可动锚时美股页签零信号）',
    );

    // ── ③ 改 L 层人工位 → 生效值切换 + 标记 + 单票上限连带重算（EC-6）────────────
    const toL1 = await optionsdeskControllerUpdate(anchorId, { lLevelManual: 'L1' }, cfg);
    assert.equal(toL1.status, 200, `update expected 200, got ${toL1.status}`);
    assert.equal(toL1.data.lLevelEffective, 'L1', '生效 L 层切到人工值');
    assert.equal(toL1.data.lLevelIsManual, true, '人工态标记');
    assert.equal(toL1.data.lLevelManual, 'L1');
    assert.equal(toL1.data.derivedLLevel, 'L2', '派生值不动（同屏对照的那一份，FR-032 ②）');

    // 落库验证：从 list 端点读回，人工态不是响应里的临时派生而是真列。
    const listed = await optionsdeskControllerList(undefined, cfg);
    assert.equal(listed.status, 200);
    const listedRow = listed.data.items.find((a) => a.id === anchorId);
    assert.equal(listedRow?.lLevelEffective, 'L1', '人工 L 层真落库（另一端点读回）');
    assert.equal(listedRow?.lLevelIsManual, true);

    // ── ④ 撤销（本 spec 的靶心）—— 三处人工位一律送 `null` ────────────────────────
    // `lLevelManual: null` 现在**直接过类型**：这一行就是 swagger `nullable: true` 补齐的
    // 机械探针，退化回非 nullable enum 时这里 typecheck 立红。
    const undoL = await optionsdeskControllerUpdate(anchorId, { lLevelManual: null }, cfg);
    assert.equal(undoL.status, 200);
    assert.equal(undoL.data.lLevelIsManual, false, '撤销 ⇒ 退出人工态');
    assert.equal(undoL.data.lLevelManual, null);
    assert.equal(undoL.data.lLevelEffective, 'L2', '立即回落到映射档（不必等上游刷新）');

    // 另两处人工位同构（置值 → 撤销），一并锁住它们的 nullable 契约不退化。
    const setV = await optionsdeskControllerUpdate(anchorId, { vManual: '188.8800' }, cfg);
    assert.equal(setV.data.vIsManual, true);
    assert.equal(Number(setV.data.v), 188.88, '生效 V = 人工值');
    assert.equal(Number(setV.data.vModel), Number(V), '模型值原样保留（撤销的回落目标）');
    const undoV = await optionsdeskControllerUpdate(anchorId, { vManual: null }, cfg);
    assert.equal(undoV.data.vIsManual, false);
    assert.equal(Number(undoV.data.v), Number(V), '撤销 ⇒ V 立即回落到模型值');

    const setCap = await optionsdeskControllerUpdate(
      anchorId,
      { positionCapManual: '0.1000' },
      cfg,
    );
    assert.equal(setCap.data.positionCapIsManual, true);
    const undoCap = await optionsdeskControllerUpdate(anchorId, { positionCapManual: null }, cfg);
    assert.equal(undoCap.data.positionCapIsManual, false);
    assert.equal(
      undoCap.data.positionCap,
      undoCap.data.derivedPositionCap,
      '撤销 ⇒ 单票上限回落到按生效 L 层派生的值',
    );

    // ── ⑤ 错误码经生成客户端对齐：同 ticker 重复建锚 → 真 409（EC-7）────────────
    try {
      await optionsdeskControllerCreate(
        { ticker: TICKER, v: V, asof: '2026-07-01', method: 'DCF', confidence: CONFIDENCE },
        cfg,
      );
      assert.fail('duplicate anchor should have thrown 409');
    } catch (e) {
      if (!axios.isAxiosError(e)) throw e; // 非 axios 错误（如上面的 assert.fail）→ 透传 = 失败
      assert.equal(e.response?.status, 409, `dup expected 409, got ${e.response?.status}`);
    }
  } finally {
    // ── cleanup：删本 spec 落的锚（同 boot 内幂等）。痕迹行不级联删是 FR-031 的设计。
    const del = await optionsdeskControllerRemove(anchorId, cfg);
    assert.equal(del.status, 204, `cleanup delete expected 204, got ${del.status}`);
  }
}
