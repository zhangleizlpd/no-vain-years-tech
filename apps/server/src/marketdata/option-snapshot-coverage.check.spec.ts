import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import type { MarketdataSyncConfig } from '../config/marketdata.config.js';
import type { PrismaService } from '../security/prisma.service.js';
import { OptionSnapshotCoverageCheck } from './option-snapshot-coverage.check.js';

/**
 * 逐合约覆盖率完整性核对单测 (047 T021, Small —— mock prisma, 零容器)。
 *
 * 🚨 本文件盯的五条都是「盲写会踩、且踩了不会红」的坑:
 * ① **分母的到期判据是 `>=` 不是 `>`** (Guardrail 7): 当日到期的合约当日仍可取快照。写成 `>`
 *    **只在到期日当天**整批漏判, 平时永远看不出来 —— 而那一天恰恰是最需要它响的一天
 * ② **逐票判定, 不是全局总数** (FR-045): PEP 730 行足以把 VICI 48 行整票消失盖在噪声里,
 *    全局阈值下那是 93.8% 覆盖率 = 绿
 * ③ **大到期日次日不许假红** (SC-002 第 ③ 向): 上一交易日在、当日已到期的腿**不进分母**。
 *    只验「会响」证不了「不乱响」, 而每月假红一次的告警等于没有告警
 * ④ **分母为空 = 无对象 ≠ 0%** (零锚 / 首日 / 整批到期): 判成 0% 会让零锚场景天天红
 * ⑤ **`evaluate()` 不告警、`check()` 才告警**: 两级补救 (T022) 要在补救成功时**不**升 ERROR,
 *    合成一个方法就没法既判定又不响
 */

/** `YYYY-MM-DD` → `@db.Date` 列的 UTC 零点 Date。 */
const day = (s: string): Date => new Date(`${s}T00:00:00Z`);

/** `@db.Date` 读出的 Date (或测试直传的字符串) → `YYYY-MM-DD`。 */
const iso = (d: Date | string): string =>
  typeof d === 'string' ? d : d.toISOString().slice(0, 10);

interface FakeSnapshotRow {
  contractId: bigint;
  contractCode: string;
  /** 本行归属交易日。 */
  sessionDate: string;
  /** 该合约的到期日 (库内住在 `option_contract`, 测试里内联)。 */
  expiryDate: string;
  underlying: { id: bigint; market: string; code: string };
}

const PEP = { id: 1n, market: 'us', code: 'PEP' };
const VICI = { id: 2n, market: 'us', code: 'VICI' };

let nextContractId = 1n;

/** 一行快照 (库内形态的最小投影)。同 code 反复调用会拿到**不同** id —— 逐行唯一即可。 */
function snap(
  underlying: { id: bigint; market: string; code: string },
  sessionDate: string,
  expiryDate: string,
  contractId: bigint,
): FakeSnapshotRow {
  return {
    contractId,
    contractCode: `US.${underlying.code}${expiryDate.replaceAll('-', '').slice(2)}P${contractId}`,
    sessionDate,
    expiryDate,
    underlying,
  };
}

/** 造一票在某日的 n 条合约行 (id 连号, 便于按 id 切「今天缺哪几条」)。 */
function chain(
  underlying: { id: bigint; market: string; code: string },
  sessionDate: string,
  expiryDate: string,
  count: number,
): FakeSnapshotRow[] {
  return Array.from({ length: count }, () =>
    snap(underlying, sessionDate, expiryDate, nextContractId++),
  );
}

/** 把一批行「搬到」另一交易日 (= 那天也采到了这些合约)。 */
function carriedTo(rows: FakeSnapshotRow[], sessionDate: string): FakeSnapshotRow[] {
  return rows.map((r) => ({ ...r, sessionDate }));
}

function makeCheck(rows: FakeSnapshotRow[], threshold = 1): OptionSnapshotCoverageCheck {
  const prisma = {
    optionDailySnapshot: {
      // 基线日 = 存在快照行的、早于 sessionDate 的最近一个交易日。
      findFirst: vi.fn(async (args: { where: { sessionDate: { lt: Date } } }) => {
        const before = iso(args.where.sessionDate.lt);
        const dates = [...new Set(rows.map((r) => r.sessionDate))].filter((d) => d < before).sort();
        const last = dates.at(-1);
        return last === undefined ? null : { sessionDate: day(last) };
      }),
      findMany: vi.fn(
        async (args: {
          where: { sessionDate: Date; contract?: { expiryDate: { gte: Date } } };
        }) => {
          const at = iso(args.where.sessionDate);
          const notExpiredBefore = args.where.contract?.expiryDate.gte;
          return rows
            .filter(
              (r) =>
                r.sessionDate === at &&
                (notExpiredBefore === undefined || r.expiryDate >= iso(notExpiredBefore)),
            )
            .map((r) => ({
              contractId: r.contractId,
              // `underlyingInstrumentId` 是**存在性层**的输入 (#231): 当日这批行里出现过的票
              // = 今天有行的票。真实侧由 select 多取一列拿到, 替身必须镜像, 否则新层拿到
              // undefined 而**不会报错**, 只会静默不判 —— 正是它要防的那种塌法。
              contract: {
                code: r.contractCode,
                underlying: r.underlying,
                underlyingInstrumentId: r.underlying.id,
              },
            }));
        },
      ),
    },
    // ── #231 存在性层用到的两个委托 ──────────────────────────────────────────────────────
    // 🚨 替身把「名册」建模成 **fixture 里出现过、且当日仍未到期的那些票**。真实侧的名册是
    //    `instrument(market='us' ∧ need_sync) ∧ 有未到期 option_contract` —— 替身没有
    //    `need_sync` / 独立合约表这两个维度, 故 **`need_sync` 闸与「合约表有而快照没有」这两条
    //    只由 IT 覆盖**（`marketdata.snapshot-integrity.it.spec.ts`, 真 PG）。此处不假装覆盖。
    instrument: {
      findMany: vi.fn(
        async (args: { where: { optionContracts: { some: { expiryDate: { gte: Date } } } } }) => {
          const asOf = iso(args.where.optionContracts.some.expiryDate.gte);
          const byId = new Map<string, { id: bigint; market: string; code: string }>();
          for (const r of rows) {
            if (r.expiryDate >= asOf) byId.set(r.underlying.id.toString(), r.underlying);
          }
          return [...byId.values()];
        },
      ),
    },
    optionContract: {
      findMany: vi.fn(
        async (args: {
          where: { underlyingInstrumentId: { in: bigint[] }; expiryDate: { gte: Date } };
        }) => {
          const asOf = iso(args.where.expiryDate.gte);
          const wanted = new Set(args.where.underlyingInstrumentId.in.map((v) => v.toString()));
          const seen = new Set<string>();
          const out: { underlyingInstrumentId: bigint; code: string }[] = [];
          for (const r of rows) {
            if (!wanted.has(r.underlying.id.toString()) || r.expiryDate < asOf) continue;
            if (seen.has(r.contractCode)) continue;
            seen.add(r.contractCode);
            out.push({ underlyingInstrumentId: r.underlying.id, code: r.contractCode });
          }
          return out;
        },
      ),
    },
  } as unknown as PrismaService;

  // 本类只读 `optionCoverageThreshold` 一项 —— 补齐其余调度参数只会让测试意图糊掉。
  return new OptionSnapshotCoverageCheck(prisma, {
    optionCoverageThreshold: threshold,
  } as unknown as MarketdataSyncConfig);
}

/** ERROR log 探针 (log-based alerting 范式下, 「告警」就是这条 log)。 */
function spyError(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
}

const MON = '2026-06-15';
const TUE = '2026-06-16';
/** #231 的用例需要**第三**个交易日: 缺席要连缺两轮才撞上「基线日也没有它」。 */
const WED = '2026-06-17';

describe('OptionSnapshotCoverageCheck', () => {
  describe('🚨 逐票判定, 不是全局总数 (FR-045)', () => {
    /**
     * 🚨 **#231 的病灶形状**: 连缺**两轮**时, 该票在基线日也没有行 ⇒ 不进分母 ⇒ 比例层对它
     * **无输出** ⇒ 判绿。上一条只证了「缺一轮」, 那轮基线日还有它。缺席必须走**名册**判。
     */
    it('🚨 连缺两轮 → 仍判 degraded (缺席走名册, 不看基线日有没有它)', async () => {
      const pepMon = chain(PEP, MON, '2026-07-17', 10);
      const viciMon = chain(VICI, MON, '2026-07-17', 4);
      // MON 两票都在; TUE 只有 PEP (VICI 第一次缺); WED 仍只有 PEP (第二次缺, 且基线日 = TUE
      // 已经没有 VICI) —— 老判据在 WED 这轮结构上判不出来。
      const check = makeCheck(
        [...pepMon, ...viciMon, ...carriedTo(pepMon, TUE), ...carriedTo(pepMon, WED)],
        1,
      );

      const report = await check.evaluate(WED);

      expect(report.status).toBe('degraded');
      expect(report.degraded.map((u) => u.symbol)).toEqual(['us:VICI']);
      // 缺席票的分母取**库内未到期合约数**(替身里 = fixture 中那 4 张), covered 恒 0。
      expect(report.degraded[0]).toMatchObject({ expected: 4, covered: 0 });
      // 逐票明细要能喂补救侧重采 (它按 instrumentId 直接重采)。
      expect(report.degraded[0].instrumentId).toBe(VICI.id);
      expect(report.degraded[0].missingContractCodes).toHaveLength(4);
    });

    it('整票缺席 → 该票 ERROR, 即便全局覆盖率仍在阈值之上 (大票盖不住小票)', async () => {
      // PEP 730 行全在 + VICI 48 行整票消失 = 全局 93.8%, 阈值 0.9 下全局判据**是绿的**。
      const pepMon = chain(PEP, MON, '2026-07-17', 730);
      const viciMon = chain(VICI, MON, '2026-07-17', 48);
      const check = makeCheck([...pepMon, ...viciMon, ...carriedTo(pepMon, TUE)], 0.9);
      const err = spyError();

      const report = await check.check(TUE);

      expect(report.status).toBe('degraded');
      expect(report.degraded.map((u) => u.symbol)).toEqual(['us:VICI']);
      expect(report.degraded[0]).toMatchObject({ expected: 48, covered: 0 });
      // 全局比值确实达标 —— 只看总数的实现在这里会跑绿。
      expect(report.covered / report.expected).toBeGreaterThan(0.9);
      expect(err).toHaveBeenCalled();
      expect(String(err.mock.calls[0][0])).toContain('us:VICI');
      err.mockRestore();
    });

    it('一批存续合约当日无数据 → ERROR 且**指明缺了哪些合约**', async () => {
      const pepMon = chain(PEP, MON, '2026-07-17', 5);
      const survived = carriedTo(pepMon.slice(0, 3), TUE);
      const check = makeCheck([...pepMon, ...survived]);
      const err = spyError();

      const report = await check.check(TUE);

      expect(report.status).toBe('degraded');
      expect(report.degraded[0]).toMatchObject({ symbol: 'us:PEP', expected: 5, covered: 3 });
      expect(report.degraded[0].missingContractCodes).toEqual([
        pepMon[3].contractCode,
        pepMon[4].contractCode,
      ]);
      // 明细进 ERROR 文案: 运维不必回查原始表就知道去补哪几条。
      expect(String(err.mock.calls[0][0])).toContain(pepMon[3].contractCode);
      err.mockRestore();
    });
  });

  describe('🚨 假阳性守卫 (SC-002 第 ③ 向)', () => {
    it('大到期日次日: 上一交易日在、当日**已到期**的腿不进分母 → 不告警', async () => {
      // 月度到期日 06-15 收盘后: 60 条当日到期 + 40 条 7 月到期。次日 06-16 那 60 条已不可采,
      // 拿它们当分母 = 每个月度到期日次日必假红一次。
      const expiring = chain(PEP, MON, MON, 60);
      const surviving = chain(PEP, MON, '2026-07-17', 40);
      const check = makeCheck([...expiring, ...surviving, ...carriedTo(surviving, TUE)]);
      const err = spyError();

      const report = await check.check(TUE);

      expect(report.status).toBe('ok');
      expect(report).toMatchObject({ expected: 40, covered: 40 });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('🚨 判据是 `到期日 >= 当日` 不是 `>`: 当日到期的腿仍在分母, 缺了照样 ERROR', async () => {
      // 当日到期的合约**当日仍可取快照** (官方「结束日期请输入今天或未来的日期」)。写成 `>`
      // 只在到期日当天静默放行整批缺行 —— 且那是这批腿最后一次可采的机会。
      const expiringToday = chain(PEP, MON, TUE, 12);
      const check = makeCheck([...expiringToday]); // 06-16 一条都没采到
      const err = spyError();

      const report = await check.check(TUE);

      expect(report).toMatchObject({ status: 'degraded', expected: 12, covered: 0 });
      expect(err).toHaveBeenCalled();
      err.mockRestore();
    });
  });

  describe('🚨 分母为空 = 无对象, 不是 0% (零锚 / 首日 / 整批到期)', () => {
    it('全表无行 (零锚 / 首日) → status=no_subject, 零告警', async () => {
      const check = makeCheck([]);
      const err = spyError();

      const report = await check.check(TUE);

      expect(report).toMatchObject({ status: 'no_subject', baselineDate: null, expected: 0 });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('基线日的合约**当日全部到期** → 分母为空 → no_subject, 零告警', async () => {
      const check = makeCheck(chain(PEP, MON, MON, 30));
      const err = spyError();

      const report = await check.check(TUE);

      expect(report).toMatchObject({ status: 'no_subject', baselineDate: MON, expected: 0 });
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('多日整体停摆: 基线取**最近有数据的那天**, 缺口不会被「昨天也空」自我掩盖', async () => {
      // 拿日历上的上一交易日当基线, 一旦那天也全缺 ⇒ 分母为空 ⇒ 判无对象 ⇒ 连续停摆静默。
      const pepMon = chain(PEP, MON, '2026-07-17', 20);
      const check = makeCheck(pepMon); // 06-16 与 06-17 都没采
      const err = spyError();

      const report = await check.check('2026-06-17');

      expect(report).toMatchObject({
        status: 'degraded',
        baselineDate: MON,
        expected: 20,
        covered: 0,
      });
      err.mockRestore();
    });
  });

  describe('阈值配置化 (先验起手 100%)', () => {
    it('缺 1/20: 阈值 1 → 告警; 阈值 0.9 → 不告警', async () => {
      const pepMon = chain(PEP, MON, '2026-07-17', 20);
      const partial = carriedTo(pepMon.slice(0, 19), TUE);

      const strict = await makeCheck([...pepMon, ...partial], 1).evaluate(TUE);
      const relaxed = await makeCheck([...pepMon, ...partial], 0.9).evaluate(TUE);

      expect(strict.status).toBe('degraded');
      expect(strict.threshold).toBe(1);
      expect(relaxed.status).toBe('ok');
      expect(relaxed.threshold).toBe(0.9);
    });
  });

  describe('🚨 evaluate() 纯判定 / check() 才告警 (两级补救要用得上)', () => {
    it('evaluate() 判 degraded 但**不**落 ERROR log', async () => {
      const pepMon = chain(PEP, MON, '2026-07-17', 4);
      const check = makeCheck(pepMon);
      const err = spyError();

      const report = await check.evaluate(TUE);

      expect(report.status).toBe('degraded');
      // 补救链路要先静默判定、补回来之后才决定响不响 (FR-046: 两级都失败才升 ERROR)。
      expect(err).not.toHaveBeenCalled();
      err.mockRestore();
    });

    it('逐票明细含 instrumentId + symbol (补救侧据此重采那几票)', async () => {
      const check = makeCheck([
        ...chain(PEP, MON, '2026-07-17', 2),
        ...chain(VICI, MON, '2026-07-17', 2),
      ]);

      const report = await check.evaluate(TUE);

      expect(report.underlyings.map((u) => [u.symbol, u.instrumentId])).toEqual([
        ['us:PEP', 1n],
        ['us:VICI', 2n],
      ]);
    });
  });
});
