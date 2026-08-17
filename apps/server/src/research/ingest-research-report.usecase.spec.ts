import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PrismaService } from '../security/prisma.service';
import { FakeObjectStorage } from '../integrations/oss/fake-object-storage.adapter';
import type { ResearchOssConfig } from '../config/index';
import { IngestResearchReportUseCase } from './ingest-research-report.usecase';
import { ResearchIngestRejectedException } from './research-ingest-rejected.exception';
import { RESEARCH_QUOTA_BYTES, buildObjectKey, contentHashOf } from './research-report.rules';

const PDF_A = Buffer.from('%PDF-1.4\nreport A\n%%EOF\n');
const PDF_B = Buffer.from('%PDF-1.4\nreport B (不同字节)\n%%EOF\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

const OSS: ResearchOssConfig = {
  kind: 'aliyun',
  region: 'oss-cn-shanghai',
  bucket: 'nvy-research-oss',
  accessKeyId: 'AK',
  accessKeySecret: 'SK',
};

interface Row {
  id: bigint;
  symbol: string;
  reportDate: Date;
  title: string;
  source: string;
  version: number;
  contentHash: string;
  sizeBytes: number;
  originalFilename: string;
  objectKey: string;
  status: string;
  uploaderKind: string;
  uploaderRef: string;
  createdAt: Date;
}

/** 行情标的目录里的一条（058 名称回显只读这两列）。 */
interface InstrumentRow {
  market: string;
  code: string;
  name: string;
}

/**
 * 内存假表而不是逐方法 vi.fn —— 本 task 要验的是 **行的状态**（留没留 PENDING / 有没有多出
 * 第二行 / 配额之和），用调用次数断言只能验到「调了几次」，验不到「库里剩下什么」。
 */
function buildPrismaFake(
  seed: Row[] = [],
  instruments: InstrumentRow[] = [],
): {
  prisma: PrismaService;
  rows: Row[];
  failUpdate: () => void;
  failInstrumentLookup: () => void;
} {
  const rows: Row[] = [...seed];
  let nextId = BigInt(rows.length + 1);
  let updateShouldFail = false;
  let instrumentLookupShouldFail = false;

  const prisma = {
    // 058 起的跨 ctx 只读面（Q7-B）。真 Prisma 侧走复合唯一键访问器 `market_code`，
    // 假表用同一个形状 —— 换成 `findFirst({ where: { market, code } })` 这里就对不上。
    instrument: {
      findUnique: vi.fn(
        async ({ where }: { where: { market_code: { market: string; code: string } } }) => {
          if (instrumentLookupShouldFail) throw new Error('标的目录不可达（模拟）');
          const k = where.market_code;
          return instruments.find((i) => i.market === k.market && i.code === k.code) ?? null;
        },
      ),
    },
    researchReport: {
      findUnique: vi.fn(
        async ({
          where,
        }: {
          where: {
            // 058 起 `symbol` 进幂等键（FR-019）—— 少这一维，「同字节换标的」会被误判为重复投递。
            uploaderKind_uploaderRef_symbol_contentHash: {
              uploaderKind: string;
              uploaderRef: string;
              symbol: string;
              contentHash: string;
            };
          };
        }) => {
          const k = where.uploaderKind_uploaderRef_symbol_contentHash;
          return (
            rows.find(
              (r) =>
                r.uploaderKind === k.uploaderKind &&
                r.uploaderRef === k.uploaderRef &&
                r.symbol === k.symbol &&
                r.contentHash === k.contentHash,
            ) ?? null
          );
        },
      ),
      // 两种用法共用一个假实现：配额按（投递方）求 `_sum.sizeBytes`、取号按（投递方, 标的）求
      // `_max.version`。`where` 里带不带 `symbol` 就是二者的分界，与真 Prisma 侧一致。
      aggregate: vi.fn(
        async ({
          where,
        }: {
          where: { uploaderKind: string; uploaderRef: string; symbol?: string };
        }) => {
          const scoped = rows.filter(
            (r) =>
              r.uploaderKind === where.uploaderKind &&
              r.uploaderRef === where.uploaderRef &&
              (where.symbol === undefined || r.symbol === where.symbol),
          );
          return {
            _sum: { sizeBytes: scoped.reduce((acc, r) => acc + r.sizeBytes, 0) },
            // 🚨 空集时 PG 的 `MAX` 返回 NULL（Prisma 给 `null`），**不是 0** —— 取号逻辑正是靠
            // 这个 null 判「本线首投」。写成 0 会把「首投」和「已有 v0」混为一谈。
            _max: {
              version: scoped.length === 0 ? null : Math.max(...scoped.map((r) => r.version)),
            },
          };
        },
      ),
      create: vi.fn(async ({ data }: { data: Omit<Row, 'id' | 'createdAt'> }) => {
        const row: Row = {
          ...data, // 058 起 `version` 由 usecase 取号后显式带进来，不再是假表写死的 1
          id: nextId++,
          source: data.source ?? '自研',
          createdAt: new Date('2026-08-15T12:00:00.000Z'),
        };
        rows.push(row);
        return row;
      }),
      update: vi.fn(
        async ({ where, data }: { where: { id: bigint }; data: { status: string } }) => {
          if (updateShouldFail) throw new Error('DB 写失败（模拟元数据落库失败）');
          const row = rows.find((r) => r.id === where.id);
          if (!row) throw new Error('row not found');
          Object.assign(row, data);
          return row;
        },
      ),
    },
  } as unknown as PrismaService;

  return {
    prisma,
    rows,
    failUpdate: () => (updateShouldFail = true),
    failInstrumentLookup: () => (instrumentLookupShouldFail = true),
  };
}

const GUEST1 = { kind: 'guest', guestName: 'friend1' } as const;
const GUEST2 = { kind: 'guest', guestName: 'friend2' } as const;

function input(overrides: Partial<Parameters<IngestResearchReportUseCase['execute']>[0]> = {}) {
  return {
    uploader: GUEST1,
    symbol: '1698.HK',
    reportDate: '2026-08-01',
    title: '某公司深度研报',
    file: { bytes: PDF_A, filename: 'report.pdf' },
    ...overrides,
  } as Parameters<IngestResearchReportUseCase['execute']>[0];
}

function build(seed: Row[] = [], cfg: ResearchOssConfig = OSS, instruments: InstrumentRow[] = []) {
  const { prisma, rows, failUpdate, failInstrumentLookup } = buildPrismaFake(seed, instruments);
  const storage = new FakeObjectStorage();
  const useCase = new IngestResearchReportUseCase(prisma, storage, cfg);
  return { useCase, storage, rows, failUpdate, failInstrumentLookup };
}

describe('IngestResearchReportUseCase — 首次投递 (state_branch 1)', () => {
  it('落一行 COMMITTED + 写一个对象 + 返回可反查的标识', async () => {
    const { useCase, storage, rows } = build();
    const result = await useCase.execute(input());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      symbol: 'hk:01698', // 归一后落库
      status: 'COMMITTED',
      contentHash: contentHashOf(PDF_A),
      sizeBytes: PDF_A.length,
      originalFilename: 'report.pdf',
      uploaderKind: 'guest',
      uploaderRef: 'friend1',
      source: '自研', // FR-002 未提供来源时的默认
      version: 1,
    });
    expect(storage.calls).toHaveLength(1);
    expect(result.reportId).toBe(rows[0].id.toString());
    expect(result.symbol).toBe('hk:01698');
    expect(result.deduplicated).toBe(false);
  });

  it('缺标题时由文件名兜底', async () => {
    const { useCase, rows } = build();
    await useCase.execute(
      input({ title: undefined, file: { bytes: PDF_A, filename: '某公司深度研报.pdf' } }),
    );
    expect(rows[0].title).toBe('某公司深度研报');
  });

  it('reportDate 按 UTC 落库（日历日，不随进程时区漂）', async () => {
    const { useCase, rows } = build();
    await useCase.execute(input({ reportDate: '2026-08-01' }));
    expect(rows[0].reportDate.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('IngestResearchReportUseCase — 幂等 (state_branch 2 / 3 / 6 / 7)', () => {
  it('同投递方重复同字节 → 返回既有行，MUST NOT 再碰 OSS，MUST NOT 新增行', async () => {
    const { useCase, storage, rows } = build();
    const first = await useCase.execute(input());
    const second = await useCase.execute(input({ title: '换个标题也没用' }));

    expect(rows).toHaveLength(1);
    expect(storage.calls).toHaveLength(1); // 第二次完全不碰对象存储
    expect(second.reportId).toBe(first.reportId);
    expect(second.deduplicated).toBe(true);
  });

  it('不同投递方同字节 → 各留一行，但 objectKey 相同（对象只存一份）', async () => {
    const { useCase, storage, rows } = build();
    await useCase.execute(input({ uploader: GUEST1 }));
    await useCase.execute(input({ uploader: GUEST2 }));

    expect(rows).toHaveLength(2);
    expect(rows[0].objectKey).toBe(rows[1].objectKey);
    expect(rows[0].objectKey).toBe(buildObjectKey(contentHashOf(PDF_A)));
    // 两次都写了对象 —— 同字节写同位置是幂等重写，不是「存了两份」。
    expect(storage.calls).toHaveLength(2);
    expect(storage.objectKeys[0]).toBe(storage.objectKeys[1]);
  });

  it('重投撞自己名下的 PENDING 记录 → 就地续做，不新增行、不报冲突', async () => {
    const s = build();

    // 先制造一条 PENDING：让首次的对象写入落在「不确定」态。
    s.storage.enqueue('indeterminate');
    await expect(s.useCase.execute(input())).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe('PENDING');

    // 重投同字节 → 就地续做（对象上次可能已传成，同字节写同位置是幂等重写，无害）。
    const again = await s.useCase.execute(input());
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe('COMMITTED');
    expect(again.deduplicated).toBe(false);
    expect(s.storage.calls).toHaveLength(2); // 重传了一次
  });
});

describe('IngestResearchReportUseCase — 写入失败的三种结局 (state_branch 5 / 8 / 10)', () => {
  it('对象写入被明确拒绝 → MUST NOT 留下 COMMITTED 行', async () => {
    const s = build();
    s.storage.enqueue('rejected');
    await expect(s.useCase.execute(input())).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe('PENDING');
  });

  it('可达性不确定 → MUST NOT 留下 COMMITTED 行，且拒绝理由与「确认失败」可区分', async () => {
    const s = build();
    s.storage.enqueue('indeterminate');
    const err = await s.useCase.execute(input()).catch((e: unknown): unknown => e);

    expect(err).toBeInstanceOf(ResearchIngestRejectedException);
    const code = (err as ResearchIngestRejectedException).getResponse() as { code: string };
    expect(code.code).toBe('RESEARCH_STORAGE_INDETERMINATE');
    expect(s.rows[0].status).toBe('PENDING');
  });

  it('确认被拒与不确定用不同的 code（调用方据此决定要不要重投）', async () => {
    const a = build();
    a.storage.enqueue('rejected');
    const errA = (await a.useCase
      .execute(input())
      .catch((e: unknown) => e)) as ResearchIngestRejectedException;

    const b = build();
    b.storage.enqueue('indeterminate');
    const errB = (await b.useCase
      .execute(input())
      .catch((e: unknown) => e)) as ResearchIngestRejectedException;

    expect((errA.getResponse() as { code: string }).code).not.toBe(
      (errB.getResponse() as { code: string }).code,
    );
  });

  it('对象已写入但元数据落库失败 → 留下可被扫出的 PENDING 记录（不静默丢弃）', async () => {
    const s = build();
    s.failUpdate();
    await expect(s.useCase.execute(input())).rejects.toThrow();

    expect(s.storage.calls).toHaveLength(1); // 对象确实写进去了
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe('PENDING'); // 扫 PENDING 即可发现这条孤儿
  });
});

describe('IngestResearchReportUseCase — 配额 (state_branch 18 / 19)', () => {
  function seedRow(overrides: Partial<Row>): Row {
    return {
      id: 1n,
      symbol: 'hk:00700',
      reportDate: new Date('2026-07-01T00:00:00.000Z'),
      title: '旧研报',
      source: '自研',
      version: 1,
      contentHash: 'z'.repeat(64),
      sizeBytes: RESEARCH_QUOTA_BYTES,
      originalFilename: 'old.pdf',
      objectKey: 'research/zzz/report.pdf',
      status: 'COMMITTED',
      uploaderKind: 'guest',
      uploaderRef: 'friend1',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('累计用量已达配额 → 本身完全合规的一份也被拒', async () => {
    const s = build([seedRow({})]);
    await expect(s.useCase.execute(input())).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    expect(s.rows).toHaveLength(1); // 没有新增行
    expect(s.storage.calls).toHaveLength(0); // 也没碰对象存储
  });

  it('PENDING 记录照常计入配额（重试不会因为没翻状态就免费）', async () => {
    const s = build([seedRow({ status: 'PENDING' })]);
    await expect(s.useCase.execute(input())).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
  });

  it('别人名下的用量不计入我的配额', async () => {
    const s = build([seedRow({ uploaderRef: 'friend2' })]);
    await expect(s.useCase.execute(input({ uploader: GUEST1 }))).resolves.toMatchObject({
      deduplicated: false,
    });
  });

  it('共享同一对象的两个投递方，各自全额计一次（口径蓄意高估）', async () => {
    const s = build();
    await s.useCase.execute(input({ uploader: GUEST1 }));
    await s.useCase.execute(input({ uploader: GUEST2 }));

    const used = (ref: string) =>
      s.rows.filter((r) => r.uploaderRef === ref).reduce((a, r) => a + r.sizeBytes, 0);
    expect(used('friend1')).toBe(PDF_A.length);
    expect(used('friend2')).toBe(PDF_A.length); // 不因共享对象而减半
  });

  it('续做既有 PENDING 行时不重复计入自己（否则重试会把自己顶出配额）', async () => {
    // 名下已有一条正好等于配额的 PENDING 行 —— 它就是本次要续做的那条。
    //
    // 🚨 `symbol` 必须与本次投递归一后的值一致（058 起它在幂等键里）。057 时 seedRow 默认的
    // `hk:00700` 也照样命中 —— 那正是 058 要修的错：同字节被归到另一个标的下仍被判为重复。
    const hash = contentHashOf(PDF_A);
    const s = build([
      seedRow({
        symbol: 'hk:01698',
        contentHash: hash,
        status: 'PENDING',
        objectKey: buildObjectKey(hash),
      }),
    ]);
    await expect(s.useCase.execute(input())).resolves.toMatchObject({ deduplicated: false });
    expect(s.rows).toHaveLength(1);
    expect(s.rows[0].status).toBe('COMMITTED');
  });
});

describe('IngestResearchReportUseCase — 输入不合规 (state_branch 9 / 13 / 16)', () => {
  it('对象存储未配置 → 503「该能力未启用」，不是服务故障，且带 code', async () => {
    const s = build([], { kind: 'unconfigured' });
    await expect(s.useCase.execute(input())).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    // 🚨 状态码之外必须钉 `code` —— 裸 `ServiceUnavailableException('CODE')` 的 body 没有
    //    `code` 键，只断言 503 的话那个回归捞不到（对照表八行里唯独这行读不出来）。
    const err = await s.useCase.execute(input()).catch((e: unknown) => e);
    expect((err as ResearchIngestRejectedException).getStatus()).toBe(503);
    expect((err as ResearchIngestRejectedException).getResponse()).toMatchObject({
      code: 'RESEARCH_STORAGE_NOT_CONFIGURED',
    });
    expect(s.rows).toHaveLength(0);
  });

  it('非 PDF（PNG 字节改名 .pdf）→ 拒，且判据基于内容', async () => {
    const s = build();
    await expect(
      s.useCase.execute(input({ file: { bytes: PNG, filename: 'fake.pdf' } })),
    ).rejects.toBeInstanceOf(ResearchIngestRejectedException);
    expect(s.rows).toHaveLength(0);
    expect(s.storage.calls).toHaveLength(0);
  });

  it('市场不在白名单 → 拒且 MUST NOT 落库', async () => {
    const s = build();
    await expect(s.useCase.execute(input({ symbol: 'jp:7203' }))).rejects.toBeInstanceOf(
      ResearchIngestRejectedException,
    );
    expect(s.rows).toHaveLength(0);
  });

  // SC-004 的五类里「超大」与「缺必填」发生在端点层（multipart 上限 / 查询参数校验），
  // 由 T009 的 IT 覆盖；这里验的是 usecase 自己产出的五种拒绝彼此可区分。
  it('usecase 层五类拒绝的 code 互不相同（SC-004：agent 无需试错即可纠正）', async () => {
    const codes = new Set<string>();
    const grab = async (fn: () => Promise<unknown>) => {
      const err = (await fn().catch((e: unknown) => e)) as ResearchIngestRejectedException;
      codes.add((err.getResponse() as { code: string }).code);
    };

    const notPdf = build();
    await grab(() => notPdf.useCase.execute(input({ file: { bytes: PNG, filename: 'x.pdf' } })));

    const badMarket = build();
    await grab(() => badMarket.useCase.execute(input({ symbol: 'jp:7203' })));

    const encoded = build();
    await grab(() => encoded.useCase.execute(input({ symbol: 'hk%3A1698' })));

    const quota = build([
      {
        id: 1n,
        symbol: 'hk:00700',
        reportDate: new Date('2026-07-01T00:00:00.000Z'),
        title: 'old',
        source: '自研',
        version: 1,
        contentHash: 'z'.repeat(64),
        sizeBytes: RESEARCH_QUOTA_BYTES,
        originalFilename: 'o.pdf',
        objectKey: 'research/z/report.pdf',
        status: 'COMMITTED',
        uploaderKind: 'guest',
        uploaderRef: 'friend1',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      },
    ]);
    await grab(() => quota.useCase.execute(input()));

    const storageDown = build();
    storageDown.storage.enqueue('indeterminate');
    await grab(() => storageDown.useCase.execute(input()));

    expect(codes.size).toBe(5);
  });
});

describe('IngestResearchReportUseCase — 同标的同日期不同字节 (state_branch 4)', () => {
  it('各自独立归档（它们是同一标的的不同版本，不是重复）', async () => {
    const s = build();
    const first = await s.useCase.execute(input({ file: { bytes: PDF_A, filename: 'a.pdf' } }));
    const second = await s.useCase.execute(input({ file: { bytes: PDF_B, filename: 'b.pdf' } }));

    expect(s.rows).toHaveLength(2);
    expect(s.rows[0].objectKey).not.toBe(s.rows[1].objectKey);
    // 058 起「同一标的的不同版本」这句话在数据上成立：同一条版本线，号是 1、2（此前恒为 1）。
    expect([first.version, second.version]).toEqual([1, 2]);
    expect(s.rows.map((r) => r.version)).toEqual([1, 2]);
  });
});

describe('IngestResearchReportUseCase — 标的名称回显 (058 state_branch 12 / 13 / 14)', () => {
  const TIANGONG: InstrumentRow = { market: 'hk', code: '01698', name: '天工国际' };

  it('目录里找得到 → 回显名称，且按**归一后**的 symbol 查（请求写的是 `1698.HK`）', async () => {
    const s = build([], OSS, [TIANGONG]);
    const res = await s.useCase.execute(input());
    expect(res.symbol).toBe('hk:01698');
    expect(res.instrumentName).toBe('天工国际');
  });

  it('目录里找不到 → instrumentName 为 null，投递照常成功（MUST NOT 当作准入校验）', async () => {
    const s = build([], OSS, []);
    const res = await s.useCase.execute(input());
    expect(res.instrumentName).toBeNull();
    expect(res.deduplicated).toBe(false);
    expect(s.rows[0].status).toBe('COMMITTED');
  });

  it('名称查询本身抛 → fail-open：与「找不到」同样回 null，已写成的投递 MUST NOT 被判失败', async () => {
    const s = build([], OSS, [TIANGONG]);
    s.failInstrumentLookup();
    const res = await s.useCase.execute(input());
    expect(res.instrumentName).toBeNull();
    expect(s.storage.calls).toHaveLength(1);
    expect(s.rows[0].status).toBe('COMMITTED');
  });

  it('幂等命中路径同样带名称（FR-012 无条件，不只在新建路径上）', async () => {
    const s = build([], OSS, [TIANGONG]);
    const first = await s.useCase.execute(input());
    const again = await s.useCase.execute(input());
    expect(again.deduplicated).toBe(true);
    expect(again.instrumentName).toBe(first.instrumentName);
    expect(again.instrumentName).toBe('天工国际');
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
