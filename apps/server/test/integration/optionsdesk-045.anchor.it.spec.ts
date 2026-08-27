// GOLDEN SAMPLE — 测试 Medium 档 server IT（真 PG，从 isolated-db.ts 入口取库，别自己起容器）。索引见 docs/conventions/golden-sample-registry.md，纪律见 testing.md §4。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { setupIsolatedDb } from '../_support/isolated-db';
import { recordingOutboxPublisher } from '../_support/outbox-stub';
import { noEodSeed } from '../_support/eod-seed-stub';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../src/security/prisma.service';
import {
  derivePositionCap,
  mapConfidenceToLLevel,
  computeW,
  computeWillingSellAnchors,
  computeZoneBoundaries,
} from '../../src/optionsdesk/anchor.rules';
import {
  buildImportFallbackReport,
  buildModelImportPatch,
} from '../../src/optionsdesk/anchor-cascade';
import { buildAnchorChange, toAnchorSnapshot } from '../../src/optionsdesk/anchor-history';
import { CreateAnchorUseCase } from '../../src/optionsdesk/create-anchor.usecase';
import { UpdateAnchorUseCase } from '../../src/optionsdesk/update-anchor.usecase';
import { DeleteAnchorUseCase } from '../../src/optionsdesk/delete-anchor.usecase';
import { ReviewAnchorUseCase } from '../../src/optionsdesk/review-anchor.usecase';
import { ListAnchorsUseCase } from '../../src/optionsdesk/list-anchors.usecase';
import { GetAnchorUseCase } from '../../src/optionsdesk/get-anchor.usecase';
import { GetAnchorAtUseCase } from '../../src/optionsdesk/get-anchor-at.usecase';
import { stubTradingCalendar } from '../_support/trading-calendar-stub';

// 045 T011 US1 集成 IT (**SC-011**) —— 真 PG 落库口径验证: 建锚派生值 / 两级链联动 /
// 三条回落路径 / 撤销 / 痕迹逐条 / 删锚后痕迹保留 / PIT 还原逐项一致 / 逾期筛出 /
// excluded 在锚列表可见。
//
// 装配方式 = 直接 new usecase + 真 `PrismaService` (体例同本 feature 的
// optionsdesk-045.schema.it.spec.ts): usecase 是贫血 class、无 lifecycle 语义, 验证面是
// **落库口径**; HTTP 通道层 (Guard / Pipe / Filter 真 DI) 已由
// `src/optionsdesk/optionsdesk.controller.spec.ts` 覆盖, 此处不重复起 Nest 容器。
describe('045 optionsdesk US1 锚管理集成 IT (Testcontainers PG)', () => {
  let prisma: PrismaService;
  let createAnchor: CreateAnchorUseCase;
  let updateAnchor: UpdateAnchorUseCase;
  let deleteAnchor: DeleteAnchorUseCase;
  let reviewAnchor: ReviewAnchorUseCase;
  let listAnchors: ListAnchorsUseCase;
  let getAnchor: GetAnchorUseCase;
  let getAnchorAt: GetAnchorAtUseCase;

  /** V=50 ⇒ W / 四区间 / 愿卖锚全部由 rules 派生 (本文件不复写任何档位字面量)。 */
  const baseInput = {
    ticker: 'us:AOS',
    v: '50',
    asof: new Date('2026-06-30T00:00:00Z'),
    method: 'dcf',
    confidence: '8', // → L2
    nextReview: new Date('2026-09-30T00:00:00Z'),
  };

  const tick = () => new Promise((r) => setTimeout(r, 25));

  let db: Awaited<ReturnType<typeof setupIsolatedDb>>;

  beforeAll(async () => {
    db = await setupIsolatedDb();
    process.env.DATABASE_URL = db.databaseUrl;

    prisma = new PrismaService(db.databaseUrl);
    await prisma.$connect();
    createAnchor = new CreateAnchorUseCase(
      prisma,
      recordingOutboxPublisher(),
      noEodSeed(),
      stubTradingCalendar(),
    );
    updateAnchor = new UpdateAnchorUseCase(prisma, stubTradingCalendar());
    deleteAnchor = new DeleteAnchorUseCase(prisma);
    reviewAnchor = new ReviewAnchorUseCase(prisma, stubTradingCalendar());
    listAnchors = new ListAnchorsUseCase(prisma, stubTradingCalendar());
    getAnchor = new GetAnchorUseCase(prisma, stubTradingCalendar());
    getAnchorAt = new GetAnchorAtUseCase(prisma);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await db.drop();
  });

  beforeEach(async () => {
    await prisma.$executeRawUnsafe(
      'TRUNCATE optionsdesk.anchor, optionsdesk.anchor_change RESTART IDENTITY',
    );
  });

  const changesOf = (anchorId: bigint) =>
    prisma.anchorChange.findMany({ where: { anchorId }, orderBy: { id: 'asc' } });

  describe('建锚落库 + 派生值 + EC-7', () => {
    it('建锚落库: 主行 + 生效 L 层写入时求值 + 建锚当日回填 last_reviewed_on', async () => {
      const created = await createAnchor.execute(baseInput);
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.ticker).toBe('us:AOS');
      expect(row.v.toString()).toBe('50');
      expect(row.lLevelEffective).toBe(mapConfidenceToLLevel('8'));
      expect(row.lastReviewedOn).not.toBeNull();
      expect(row.breachStartedOn).toBeNull();
    });

    it('派生值正确: W / 四区间 / 愿卖锚 / 单票上限全部与 rules 单点口径一致', async () => {
      const created = await createAnchor.execute(baseInput);
      const view = await getAnchor.execute(created.id);
      expect(view.w.equals(computeW('50'))).toBe(true);
      expect(view.zones.floor.equals(computeZoneBoundaries('50').floor)).toBe(true);
      expect(view.zones.ceiling.equals(computeZoneBoundaries('50').ceiling)).toBe(true);
      expect(view.willingSell.longHold.equals(computeWillingSellAnchors('50').longHold)).toBe(true);
      expect(view.willingSell.rent.equals(computeWillingSellAnchors('50').rent)).toBe(true);
      expect(view.effective.positionCap!.equals(derivePositionCap('L2')!)).toBe(true);
    });

    it('EC-7 同 ticker 重复建锚 → 409 且不产生第二行、不改既有行', async () => {
      const first = await createAnchor.execute(baseInput);
      await expect(createAnchor.execute({ ...baseInput, v: '99' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      const rows = await prisma.anchor.findMany({ where: { ticker: 'us:AOS' } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.id).toBe(first.id);
      expect(rows[0]!.v.toString()).toBe('50');
    });
  });

  describe('两级链联动落库 (confidence → L 层 → 单票上限)', () => {
    it('state_branch: confidence 改动 ∧ 两覆盖位均空 → 生效 L 层与单票上限沿链刷新', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { confidence: '9.5' });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelEffective).toBe(mapConfidenceToLLevel('9.5'));
      const view = await getAnchor.execute(created.id);
      expect(view.effective.positionCap!.equals(derivePositionCap('L1')!)).toBe(true);
    });

    it('state_branch: L 层人工调整 → 落人工位标记, 单票上限改从**人工** L 层派生', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3' });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelManual).toBe('L3');
      expect(row.lLevelEffective).toBe('L3');
      const view = await getAnchor.execute(created.id);
      expect(view.effective.lLevelIsManual).toBe(true);
      expect(view.effective.positionCap!.equals(derivePositionCap('L3')!)).toBe(true);
      // FR-032 ② 同屏对照: 派生值仍是 confidence 映射档
      expect(view.effective.derived.lLevel).toBe(mapConfidenceToLLevel('8'));
    });

    it('state_branch: 单票上限人工调整 → 标记落库 + 派生值仍可见 (同屏对照)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { positionCapManual: '0.1' });
      const view = await getAnchor.execute(created.id);
      expect(view.effective.positionCapIsManual).toBe(true);
      expect(view.effective.positionCap!.toString()).toBe('0.1');
      expect(view.effective.derived.positionCap!.equals(derivePositionCap('L2')!)).toBe(true);
    });

    it('任一时刻只有一个生效 L 层 (人工位列与生效列各司其职, 无第二份真相)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L4' });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelEffective).toBe(row.lLevelManual);
      // L4 无 SoT 上限口径 ⇒ null, 禁自造
      const view = await getAnchor.execute(created.id);
      expect(view.effective.positionCap).toBeNull();
    });
  });

  describe('三条回落路径端到端 + 撤销', () => {
    it('state_branch ③: confidence_source = manual 改 confidence → L 层与上限人工值一并回落', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3', positionCapManual: '0.1' });
      await updateAnchor.execute(created.id, { confidence: '9.5' });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelManual).toBeNull();
      expect(row.positionCapManual).toBeNull();
      expect(row.lLevelEffective).toBe(mapConfidenceToLLevel('9.5'));
    });

    it('state_branch: L 层与上限同时人工态 → 一并回落, **无只回落其中一处的中间态**', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3', positionCapManual: '0.1' });
      const after = await updateAnchor.execute(created.id, { confidence: '2' });
      expect([after.lLevelManual, after.positionCapManual]).toEqual([null, null]);
    });

    it('state_branch ②: 人工改 L 层 ∧ 上限处于人工态 → 上限回落 (EC-6 上游赢)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { positionCapManual: '0.1' });
      await updateAnchor.execute(created.id, { lLevelManual: 'L1' });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.positionCapManual).toBeNull();
      expect(row.lLevelManual).toBe('L1');
    });

    it('state_branch ①: 模型 import 刷 V/confidence → 三处人工值全部回落 + 来源翻 model', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, {
        vManual: '55',
        lLevelManual: 'L3',
        positionCapManual: '0.1',
      });
      const before = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      // import 脚本形态: 用封闭键集 patch 落库 (键集本身就是 Guardrail 11 的载体)。
      const patch = buildModelImportPatch({
        v: '60',
        confidence: '9.5',
        asof: new Date('2026-07-31T00:00:00Z'),
        method: 'dcf',
      });
      await prisma.anchor.update({ where: { id: created.id }, data: patch });
      const after = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect([after.vManual, after.lLevelManual, after.positionCapManual]).toEqual([
        null,
        null,
        null,
      ]);
      expect(after.confidenceSource).toBe('model');
      expect(after.lLevelEffective).toBe(mapConfidenceToLLevel('9.5'));
      expect(before.confidenceSource).toBe('manual');
    });

    it('state_branch: 模型首次覆盖手工锚 → 该锚自动转只读 (改 confidence 写侧拒)', async () => {
      const created = await createAnchor.execute(baseInput);
      await prisma.anchor.update({
        where: { id: created.id },
        data: buildModelImportPatch({
          v: '60',
          confidence: '9.5',
          asof: new Date('2026-07-31T00:00:00Z'),
          method: 'dcf',
        }),
      });
      await expect(updateAnchor.execute(created.id, { confidence: '3' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('🚨 state_branch: import 刷 V → next_review 不重置、last_reviewed_on 不动 (红标不解除)', async () => {
      const created = await createAnchor.execute(baseInput);
      const before = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      await prisma.anchor.update({
        where: { id: created.id },
        data: buildModelImportPatch({
          v: '60',
          confidence: '9.5',
          asof: new Date('2026-07-31T00:00:00Z'),
          method: 'dcf',
        }),
      });
      const after = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(after.nextReview).toEqual(before.nextReview);
      expect(after.lastReviewedOn).toEqual(before.lastReviewedOn);
      expect(after.breachStartedOn).toEqual(before.breachStartedOn);
    });

    it('state_branch: import 批量刷 → 差异报告逐条列出每一个被回落的人工值 (禁静默)', async () => {
      const a = await createAnchor.execute(baseInput);
      const b = await createAnchor.execute({ ...baseInput, ticker: 'us:TAP' });
      await updateAnchor.execute(a.id, { vManual: '55', lLevelManual: 'L3' });
      await updateAnchor.execute(b.id, { positionCapManual: '0.1' });
      const rows = await prisma.anchor.findMany({ orderBy: { id: 'asc' } });
      const report = buildImportFallbackReport(
        rows.map((row) => ({
          ticker: row.ticker,
          manual: {
            vManual: row.vManual,
            lLevelManual: row.lLevelManual as 'L1' | 'L2' | 'L3' | 'L4' | null,
            positionCapManual: row.positionCapManual,
          },
          next: { v: '60', confidence: '9.5' },
        })),
      );
      expect(report).toHaveLength(3);
      expect(report.map((e) => `${e.ticker}:${e.slot}`).sort()).toEqual([
        'us:AOS:lLevel',
        'us:AOS:v',
        'us:TAP:positionCap',
      ]);
    });

    it('state_branch: 撤销任一层 → 自身立即回落 + 下游随之 + 记痕迹', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3', positionCapManual: '0.1' });
      await updateAnchor.execute(created.id, { lLevelManual: null });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelManual).toBeNull();
      expect(row.positionCapManual).toBeNull(); // 下游随之
      expect(row.lLevelEffective).toBe(mapConfidenceToLLevel('8'));
      const changes = await changesOf(created.id);
      // 一条痕迹记全本次真变的列: 两个人工位 + 随之重算的生效 L 层。
      expect(changes.at(-1)!.changedFields.sort()).toEqual([
        'lLevelEffective',
        'lLevelManual',
        'positionCapManual',
      ]);
      expect(changes.at(-1)!.source).toBe('manual');
    });

    it('EC-5 人工值恰好等于派生值 → 仍落人工位 (痕迹保住「谁设的」)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: mapConfidenceToLLevel('8') });
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.lLevelManual).not.toBeNull();
      const view = await getAnchor.execute(created.id);
      expect(view.effective.lLevelIsManual).toBe(true);
    });
  });

  describe('变更痕迹逐条落库 + 删锚保留 (FR-031)', () => {
    it('state_branch: 锚被修改 → 落一条字段级痕迹, 当前值与历史值并存', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { v: '52', method: 'ddm' });
      const changes = await changesOf(created.id);
      expect(changes).toHaveLength(2); // 建锚 1 + 本次 1
      const last = changes.at(-1)!;
      expect(last.changedFields.sort()).toEqual(['method', 'v']);
      expect((last.beforeValues as Record<string, unknown>).v).toBe('50');
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.v.toString()).toBe('52'); // 当前值
    });

    it('每次变更恰好一条痕迹, source 可分辨 model / manual', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { v: '52' }, 'model');
      await updateAnchor.execute(created.id, { v: '53' }, 'manual');
      const changes = await changesOf(created.id);
      expect(changes.map((c) => c.source)).toEqual(['manual', 'model', 'manual']);
    });

    it('复审也落痕迹 (nextReview + lastReviewedOn), 且不碰 breach_started_on', async () => {
      const created = await createAnchor.execute(baseInput);
      await prisma.anchor.update({
        where: { id: created.id },
        data: { breachStartedOn: new Date('2026-07-20T00:00:00Z') },
      });
      await reviewAnchor.execute(created.id, new Date('2026-12-31T00:00:00Z'));
      const row = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      expect(row.nextReview).toEqual(new Date('2026-12-31T00:00:00Z'));
      expect(row.breachStartedOn).toEqual(new Date('2026-07-20T00:00:00Z'));
      const changes = await changesOf(created.id);
      // last_reviewed_on 建锚当日已回填 = 今日, 同日复审它没真变 ⇒ 不进 changed_fields
      // (值没变不刷噪声列); 推进的 next_review 则逐条留痕。
      expect(changes.at(-1)!.changedFields).toEqual(['nextReview']);
      expect((changes.at(-1)!.beforeValues as Record<string, unknown>).nextReview).toBe(
        baseInput.nextReview.toISOString(),
      );
    });

    it('state_branch: 锚被删除 → 痕迹保留不级联 (删除本身也是一条痕迹)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { v: '52' });
      await deleteAnchor.execute(created.id);
      expect(await prisma.anchor.findUnique({ where: { id: created.id } })).toBeNull();
      const changes = await changesOf(created.id);
      expect(changes).toHaveLength(3); // 建 + 改 + 删
      expect((changes.at(-1)!.beforeValues as Record<string, unknown>).v).toBe('52');
    });

    it('import 刷 confidence ∧ L 层人工态 → 回落**并记入痕迹**', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3' });
      const before = await prisma.anchor.findUniqueOrThrow({ where: { id: created.id } });
      const patch = buildModelImportPatch({
        v: '60',
        confidence: '9.5',
        asof: new Date('2026-07-31T00:00:00Z'),
        method: 'dcf',
      });
      // interface 无隐式 index signature (TS 已知限制) → 经 unknown 转 Record 喂 buildAnchorChange。
      const change = buildAnchorChange(
        toAnchorSnapshot(before),
        patch as unknown as Record<string, unknown>,
        'model',
      )!;
      await prisma.$transaction([
        prisma.anchor.update({ where: { id: created.id }, data: patch }),
        prisma.anchorChange.create({
          data: {
            anchorId: created.id,
            changedFields: [...change.changedFields],
            beforeValues: change.beforeValues,
            source: change.source,
          },
        }),
      ]);
      const changes = await changesOf(created.id);
      expect(changes.at(-1)!.source).toBe('model');
      expect(changes.at(-1)!.changedFields).toContain('lLevelManual');
      expect((changes.at(-1)!.beforeValues as Record<string, unknown>).lLevelManual).toBe('L3');
    });
  });

  describe('PIT 还原与当时显示逐项一致 (SC-011)', () => {
    it('state_branch: 按历史时点查询 → V / W / L 层 / 单票上限 / 愿卖锚逐项还原', async () => {
      const created = await createAnchor.execute(baseInput);
      const viewThen = await getAnchor.execute(created.id);
      await tick();
      const at = new Date();
      await tick();
      await updateAnchor.execute(created.id, { v: '90', confidence: '9.5' });

      const pit = await getAnchorAt.execute(created.id, at);
      expect(pit).not.toBeNull();
      expect(pit!.v.equals(viewThen.effective.v)).toBe(true);
      expect(pit!.w.equals(viewThen.w)).toBe(true);
      expect(pit!.lLevel).toBe(viewThen.effective.lLevel);
      expect(pit!.positionCap!.equals(viewThen.effective.positionCap!)).toBe(true);
      expect(pit!.willingSell.longHold.equals(viewThen.willingSell.longHold)).toBe(true);
      expect(pit!.willingSell.rent.equals(viewThen.willingSell.rent)).toBe(true);

      // 当前值已变 —— 证明还原的不是「现在」
      const now = await getAnchor.execute(created.id);
      expect(now.effective.v.toString()).toBe('90');
    });

    it('人工态也被还原 (当时是谁设的值可分辨)', async () => {
      const created = await createAnchor.execute(baseInput);
      await updateAnchor.execute(created.id, { lLevelManual: 'L3' });
      await tick();
      const at = new Date();
      await tick();
      await updateAnchor.execute(created.id, { lLevelManual: null });

      const pit = await getAnchorAt.execute(created.id, at);
      expect(pit!.lLevelIsManual).toBe(true);
      expect(pit!.lLevel).toBe('L3');
      const now = await getAnchor.execute(created.id);
      expect(now.effective.lLevelIsManual).toBe(false);
    });

    it('删锚后仍可按时点还原 (痕迹不级联的兑现处)', async () => {
      const created = await createAnchor.execute(baseInput);
      await tick();
      const at = new Date();
      await tick();
      await deleteAnchor.execute(created.id);
      const pit = await getAnchorAt.execute(created.id, at);
      expect(pit!.v.toString()).toBe('50');
      expect(pit!.lLevel).toBe(mapConfidenceToLLevel('8'));
    });

    it('时点早于建锚 → null (不返半截快照)', async () => {
      const created = await createAnchor.execute(baseInput);
      const pit = await getAnchorAt.execute(created.id, new Date('2020-01-01T00:00:00Z'));
      expect(pit).toBeNull();
    });
  });

  describe('锚列表筛选 (FR-004 / FR-005 + Guardrail 12)', () => {
    it('逾期锚可被单独筛出为待复审清单, 未逾期的不在其中', async () => {
      const overdue = await createAnchor.execute({
        ...baseInput,
        ticker: 'us:PEP',
        nextReview: new Date('2020-01-01T00:00:00Z'),
      });
      await createAnchor.execute({
        ...baseInput,
        ticker: 'us:VICI',
        nextReview: new Date('2099-01-01T00:00:00Z'),
      });
      const pending = await listAnchors.execute({ pendingReview: true });
      expect(pending.map((v) => v.row.id)).toEqual([overdue.id]);
      expect(pending[0]!.overdue).toBe(true);
      expect((await listAnchors.execute({})).length).toBe(2);
    });

    it('🚨 state_branch: excluded = true 的锚在**锚列表可见**并带 exclude_reason', async () => {
      await createAnchor.execute({
        ...baseInput,
        ticker: 'us:LULU',
        excluded: true,
        excludeReason: '暂不交易',
      });
      const all = await listAnchors.execute({});
      expect(all).toHaveLength(1);
      expect(all[0]!.row.excluded).toBe(true);
      expect(all[0]!.row.excludeReason).toBe('暂不交易');
    });

    it('excluded 筛选双向可用 (true 只看已排除 / false 只看未排除)', async () => {
      await createAnchor.execute({ ...baseInput, ticker: 'us:LULU', excluded: true });
      await createAnchor.execute({ ...baseInput, ticker: 'us:CPB' });
      expect((await listAnchors.execute({ excluded: true })).map((v) => v.row.ticker)).toEqual([
        'us:LULU',
      ]);
      expect((await listAnchors.execute({ excluded: false })).map((v) => v.row.ticker)).toEqual([
        'us:CPB',
      ]);
    });

    it('EC-10 建锚即逾期 (next_review 早于 asof) → 允许保存且可识别', async () => {
      const created = await createAnchor.execute({
        ...baseInput,
        ticker: 'us:PSKY',
        nextReview: new Date('2026-01-01T00:00:00Z'),
      });
      expect(created.overdueAgainstAsof).toBe(true);
      const view = await getAnchor.execute(created.id);
      expect(view.overdueAgainstAsof).toBe(true);
    });
  });
});
