import { describe, expect, it, vi } from 'vitest';
import { Prisma } from '../generated/prisma/client';
import { OPTION_SNAPSHOT_MAX_CONTRACT_CODES } from '../marketdata/option-snapshot.port';
import { BUILD_RECALL_DTE, RENT_RECALL_DTE } from './leg-recall.rules';
import {
  WINDOW_SUPPORTED_MARKETS,
  bootstrapWindowFor,
  rentBootstrapBudgetWindow,
  type RentBootstrapWindowSelection,
} from './leg-window.rules';

const SPOT = new Prisma.Decimal('100');

describe('bootstrapWindowFor —— bootstrap 宽窗由召回常量派生 (068 FR-004; 064 教义存续场景)', () => {
  it('DTE 段 = 两个召回段的并 (禁手写第二份边界数)', () => {
    const window = bootstrapWindowFor('us', SPOT);
    expect(window.dteMin).toBe(Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min));
    expect(window.dteMax).toBe(Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max));
    // 并集 ⇒ 两段各自整段都被覆盖 (取交 / 取其一都会在这里红)。
    expect(window.dteMin).toBeLessThanOrEqual(BUILD_RECALL_DTE.min);
    expect(window.dteMin).toBeLessThanOrEqual(RENT_RECALL_DTE.min);
    expect(window.dteMax).toBeGreaterThanOrEqual(BUILD_RECALL_DTE.max);
    expect(window.dteMax).toBeGreaterThanOrEqual(RENT_RECALL_DTE.max);
  });

  it('🚨 改动 RENT_RECALL_DTE.max 后窗随之变 —— 硬编码上界会在这里红', async () => {
    vi.resetModules();
    vi.doMock('./leg-recall.rules', async (importOriginal) => {
      const actual = await importOriginal<typeof import('./leg-recall.rules')>();
      return { ...actual, RENT_RECALL_DTE: { min: actual.RENT_RECALL_DTE.min, max: 999 } };
    });
    try {
      const remocked = await import('./leg-window.rules.js');
      expect(remocked.bootstrapWindowFor('us', SPOT).dteMax).toBe(999);
    } finally {
      vi.doUnmock('./leg-recall.rules');
      vi.resetModules();
    }
  });

  it('类型 PUT + 只要标准合约 (047 FR-008)', () => {
    const window = bootstrapWindowFor('us', SPOT);
    expect(window.optionType).toBe('PUT');
    expect(window.isStandard).toBe(true);
  });

  it('strike 上下界随 spot 缩放 (盘中基准喂进来就跟着动)', () => {
    const low = bootstrapWindowFor('us', new Prisma.Decimal('100'));
    const high = bootstrapWindowFor('us', new Prisma.Decimal('200'));
    expect(high.strikeMin.equals(low.strikeMin.times(2))).toBe(true);
    expect(high.strikeMax.equals(low.strikeMax.times(2))).toBe(true);
    expect(low.strikeMin.lessThan(SPOT)).toBe(true);
    expect(low.strikeMax.greaterThan(SPOT)).toBe(true);
  });

  /**
   * 🚨 **反例样本已从 `hk` 换成 `cn`** (071 T004①): 本条此前拿 hk 当「未支持市场」的被试对象,
   * 而 071 把 hk 接进白名单 ⇒ 再拿它当反例就是**测了个寂寞**(恒不 throw, 而断言写的是 throw
   * ⇒ 当场红, 这是好事; 坏的是有人顺手把断言删掉而不是换样本)。
   * 📌 `IMPORTABLE_MARKETS = ['us','hk']` 没有第三个市场 ⇒ `cn` 建不了锚, 但本函数是**纯函数
   * 纵深防御**、不经建锚校验 ⇒ 拿 cn 当反例成立且更贴真实防御面 (调用方闸失效时兜住)。
   */
  it('🚨 非已支持市场 (cn) → throw 且消息列出已支持市场 (静默返空会让它悄悄拿到 us 的窗)', () => {
    expect(() => bootstrapWindowFor('cn', SPOT)).toThrow(/cn/);
    expect(() => bootstrapWindowFor('cn', SPOT)).toThrow(
      new RegExp(WINDOW_SUPPORTED_MARKETS.join('|')),
    );
    expect(() => bootstrapWindowFor('', SPOT)).toThrow();
  });

  it('🚨 hk 已进白名单 ⇒ 返窗而非 throw (071 FR-001)', () => {
    expect(WINDOW_SUPPORTED_MARKETS).toEqual(['us', 'hk']);
    const hk = bootstrapWindowFor('hk', SPOT);
    expect(hk.optionType).toBe('PUT');
    expect(hk.isStandard).toBe(true);
    expect(hk.dteMin).toBe(Math.min(BUILD_RECALL_DTE.min, RENT_RECALL_DTE.min));
    expect(hk.dteMax).toBe(Math.max(BUILD_RECALL_DTE.max, RENT_RECALL_DTE.max));
  });

  /**
   * 🚨 **美股逐值零变化** (071 SC-004)。071 只往白名单加数据、不动派生逻辑 ⇒ us 的窗必须
   * 逐值不动。期望值**硬编码**: 从常量反算等于拿被测对象当基线。
   */
  it('🚨 us 逐值不变 (SC-004); hk 走自己的下界 —— 下界 per-market、上界仍单值 (T004②③)', () => {
    const us = bootstrapWindowFor('us', SPOT);
    const hk = bootstrapWindowFor('hk', SPOT);
    expect(us.strikeMin.toString()).toBe('70'); // 100 × 0.7 —— 美股逐值不动
    expect(us.strikeMax.toString()).toBe('105'); // 100 × 1.05
    expect(hk.strikeMin.toString()).toBe('60'); // 100 × 0.6 —— 071 T004② 落值
    expect(hk.strikeMax.toString()).toBe('105'); // 上界**蓄意**保持单值 (T004③)
    // 判据分野钉死: 下界两市不同、上界两市相同。写成两条 equals 而非只断言取值 —— 只断言
    // 取值时, 有人把上界也 per-market 化并让两市恰好同值, 这条不会红。
    expect(hk.strikeMin.equals(us.strikeMin)).toBe(false);
    expect(hk.strikeMax.equals(us.strikeMax)).toBe(true);
  });

  /**
   * 🚨 **下界与成色上界的碰撞是结构性缺陷, per-market 化只是缓解、不是根治** (issue #308)。
   *
   * 收租成色上界 = `axis × 1.03`, `axis = min(spot, W)`, `W = 0.8 × V` ⇒ `V` 相对 spot 偏低时
   * 上界 ≈ `0.824 × V/spot × spot` 会**低过**下界 ⇒ bootstrap 首日收租候选恒空。
   *
   * EVIDENCE: 2026-09-04 我方直查 prod 全部 28 只港股锚 —— 按 `0.824×V < 下界×spot` 判, 下界
   * 0.7 时 8 只恒空; 落 0.6 后剩 3 只 (`hk:00005` 上界 0.428×spot · `hk:03690` 0.434 ·
   * `hk:01810` 0.464)。美股同形态未修 (`us:APA` 0.635×spot), 本片受 SC-004 约束不动美股。
   * 🚫 **MUST NOT 靠继续调低下界去追它** —— 2026-09-04 EOD 分档实测 `[0.40,0.45)` 档条件
   * 通过率 **0%** (7 条带价腿全部低于权利金门槛), 再低就是纯浪费外呼。根治要动的是上界的
   * W 派生形态, 归 #308。
   */
  it('🚨 落 0.6 后仍有锚会撞上界 —— 本条钉住「缓解不是根治」, 防止有人据此关掉 #308', () => {
    const hk = bootstrapWindowFor('hk', SPOT);
    // hk:00005 那类: 上界 0.428 × spot < 下界 0.6 × spot ⇒ 窗内无解, 仍恒空。
    const ceilingOf00005 = SPOT.times(new Prisma.Decimal('0.428'));
    expect(hk.strikeMin.greaterThan(ceilingOf00005)).toBe(true);
    // hk:00941 那类 (上界 0.681): 0.6 < 0.681 ⇒ 窗内有解, 这批是本次落值救回来的。
    const ceilingOf00941 = SPOT.times(new Prisma.Decimal('0.681'));
    expect(hk.strikeMin.lessThan(ceilingOf00941)).toBe(true);
  });

  it('🚨 windowTripwire 已随 064 覆盖范式退役 —— 绊线导出不复存在 (068 D1 退役清单)', async () => {
    const mod = await import('./leg-window.rules.js');
    expect('windowTripwire' in mod).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 077 —— 收租 bootstrap 预算窗 (语义过滤 + 以行权价档为原子的预算裁剪)
// ─────────────────────────────────────────────────────────────────────────────

const d = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

/** 入窗档按**数值**升序列出 —— 直接比 Set 会被字符串序 ('100' < '99') 骗过去。 */
const sortedStrikes = (selection: RentBootstrapWindowSelection): string[] =>
  [...selection.strikes].sort((a, b) => Number(a) - Number(b));

/** 一个合约一项、同档重复出现 —— 与 `inSegment.map((c) => c.strikePrice)` 的形态一致。 */
const codes = (...pairs: readonly (readonly [string, number])[]): Prisma.Decimal[] =>
  pairs.flatMap(([k, n]) => Array.from({ length: n }, () => d(k)));

describe('rentBootstrapBudgetWindow —— 收租 bootstrap 候选窗 (077 FR-001/002/003/004/005/008/010)', () => {
  it('① 无行权价下界: K 任意低都进; 只有超过成色上界比例项 (axis × 1.03) 的被滤掉 (FR-003 / FR-004)', () => {
    const selection = rentBootstrapBudgetWindow({
      // spot 100 / W 200 ⇒ axis = 100 ⇒ 上界 103 (闭区间)。
      strikes: codes(
        ['1', 1],
        ['20', 1],
        ['70', 1],
        ['100', 1],
        ['103', 1],
        ['103.01', 1],
        ['150', 1],
      ),
      spot: d('100'),
      w: d('200'),
      budget: OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
    });
    // 064 矩形窗的 0.7 × spot = 70 下界会把 1 / 20 挡在外面 —— 本片修的正是这条静默缺腿。
    expect(sortedStrikes(selection)).toEqual(['1', '20', '70', '100', '103']);
    // SC-003 上半: ① 非空 ⇒ 候选非空, 且该性质不依赖任何标的的估值/市价比。
    expect(selection.strikes.size).toBeGreaterThan(0);
    expect(selection.trimmed).toBe(0);
  });

  it('② 锚定轴经 resolveCeilingAxis: W ≥ spot 时退化为 spot 逐值相同, W < spot 时轴随 W 下移 (EC1 / branch 4)', () => {
    const degenerate = rentBootstrapBudgetWindow({
      strikes: codes(['103', 1], ['104', 1]),
      spot: d('100'),
      w: d('120'),
      budget: 10,
    });
    const atSpot = rentBootstrapBudgetWindow({
      strikes: codes(['103', 1], ['104', 1]),
      spot: d('100'),
      w: d('100'),
      budget: 10,
    });
    // W ≥ spot ⇒ axis = spot ⇒ 与「轴就是 spot」那一版逐值相同。
    expect(sortedStrikes(degenerate)).toEqual(['103']);
    expect(sortedStrikes(degenerate)).toEqual(sortedStrikes(atSpot));
    expect(degenerate.trimmed).toBe(atSpot.trimmed);

    // 🚨 非退化那一半是本条的判据核心: W < spot ⇒ axis = W = 80 ⇒ 上界 82.4,
    //    K=100 (若拿裸 spot 当轴则必进) MUST 出局。
    const shifted = rentBootstrapBudgetWindow({
      strikes: codes(['82', 1], ['83', 1], ['100', 1]),
      spot: d('100'),
      w: d('80'),
      budget: 10,
    });
    expect(sortedStrikes(shifted)).toEqual(['82']);
  });

  it('③ 过滤后码数 ≤ 预算 ⇒ 全进、trimmed 恒 0 (branch 1 / SC-002 / SC-003 下半)', () => {
    const strikes = codes(['96', 2], ['99', 3], ['102', 1], ['150', 4]);
    const selection = rentBootstrapBudgetWindow({
      strikes,
      spot: d('100'),
      w: d('200'),
      budget: 10,
    });
    expect(sortedStrikes(selection)).toEqual(['96', '99', '102']);
    expect(selection.trimmed).toBe(0);
    // 候选码数 ≤ 预算 —— 由定义论证, 与标的数据无关 (SC-002)。
    const eligible = strikes.filter((k) => k.lessThanOrEqualTo(d('103'))).length;
    expect(eligible - selection.trimmed).toBeLessThanOrEqual(10);
  });

  it('④ 过滤后码数 > 预算 ⇒ 按档距升序纳入, 跨边界那档整档不纳入, 后续档不再回捡 (branch 2 / EC4 / US1-AS3)', () => {
    const selection = rentBootstrapBudgetWindow({
      // axis = 100。档距: 100→0 · 99→1 · 97→3 · 90→10。合计 8 码。
      strikes: codes(['100', 2], ['99', 2], ['97', 3], ['90', 1]),
      spot: d('100'),
      w: d('200'),
      budget: 6,
    });
    // 100 (2) + 99 (2) = 4; 再加 97 那档 3 码就是 7 > 6 ⇒ 停。预算蓄意用不满 (6 里只用 4)。
    expect(sortedStrikes(selection)).toEqual(['99', '100']);
    // 🚨 「即停」而非「跳过再回捡」: K=90 只 1 码、塞得下, 但它比停下那档更远 ⇒ 不纳入。
    expect(selection.strikes.has('90')).toBe(false);
    expect(selection.trimmed).toBe(4);
  });

  it('⑤ 恰好等于预算 ⇒ 不裁 (闭区间, EC3)', () => {
    const selection = rentBootstrapBudgetWindow({
      strikes: codes(['100', 2], ['99', 3]),
      spot: d('100'),
      w: d('200'),
      budget: 5,
    });
    expect(sortedStrikes(selection)).toEqual(['99', '100']);
    expect(selection.trimmed).toBe(0);
  });

  it('⑥ 裁剪以行权价档为原子: 同一 K 的三个到期日同进同出, 没有「一半在窗内」的中间态 (FR-001 末句)', () => {
    const chain = codes(['100', 1], ['101', 3]); // 101 那档是三个到期日
    const tooTight = rentBootstrapBudgetWindow({
      strikes: chain,
      spot: d('100'),
      w: d('200'),
      budget: 2, // 装得下 100 那档 (1 码) + 101 的一部分 —— 按码裁就会裁进档内部
    });
    expect(sortedStrikes(tooTight)).toEqual(['100']);
    expect(tooTight.strikes.has('101')).toBe(false);
    expect(tooTight.trimmed).toBe(3); // 整档三个到期日一起出局

    const roomy = rentBootstrapBudgetWindow({
      strikes: chain,
      spot: d('100'),
      w: d('200'),
      budget: 4,
    });
    expect(sortedStrikes(roomy)).toEqual(['100', '101']);
    expect(roomy.trimmed).toBe(0);
  });

  it('⑦ 跨档等距并列 ⇒ 取行权价较小者 (更深虚 = 收租更保守); 输入次序换过来结论不变 (FR-008 残余项 / EC5)', () => {
    for (const strikes of [codes(['98', 1], ['102', 1]), codes(['102', 1], ['98', 1])]) {
      const selection = rentBootstrapBudgetWindow({
        strikes,
        spot: d('100'),
        w: d('200'),
        budget: 1,
      });
      expect(sortedStrikes(selection)).toEqual(['98']);
      expect(selection.trimmed).toBe(1);
    }
  });

  it('⑧ 上界之下一档都没有 ⇒ 空集且 trimmed = 0 —— 「本就没有」MUST NOT 报成「被裁 N 条」 (branch 3 / EC2 / SC-007)', () => {
    const selection = rentBootstrapBudgetWindow({
      // axis = min(100, 90) = 90 ⇒ 上界 92.7, 链上最低一档 100 已在其上。
      strikes: codes(['100', 2], ['110', 3], ['120', 1]),
      spot: d('100'),
      w: d('90'),
      budget: OPTION_SNAPSHOT_MAX_CONTRACT_CODES,
    });
    expect(selection.strikes.size).toBe(0);
    // 🚨 被**上界**滤掉的不是被**预算**裁掉的 —— 屏上那个数只答后者, 混在一起就没法解释。
    expect(selection.trimmed).toBe(0);
  });

  it('⑨ 同一输入集打乱次序两次求解逐值相同 (FR-008; 上游 findMany 无 orderBy)', () => {
    const base = codes(['100', 2], ['99', 2], ['101', 2], ['97', 1], ['103', 1], ['150', 2]);
    const shuffled = [...base].reverse();
    const rotated = [...base.slice(3), ...base.slice(0, 3)];
    const solve = (strikes: readonly Prisma.Decimal[]): RentBootstrapWindowSelection =>
      rentBootstrapBudgetWindow({ strikes, spot: d('100'), w: d('200'), budget: 5 });
    const first = solve(shuffled);
    const second = solve(rotated);
    expect(sortedStrikes(first)).toEqual(sortedStrikes(second));
    expect(first.trimmed).toBe(second.trimmed);
    // 逐值钉死, 免得两边同时错成一样 (裁剪真发生: 8 码合格、预算 5)。
    expect(sortedStrikes(first)).toEqual(['99', '100']);
    expect(first.trimmed).toBe(4);
  });
});
