import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 072 锚待审箱审批线上化 —— Expo Web e2e（hermetic）。
//
// T018 覆盖：「我的」审批栏内嵌面板（admin 默认栏）→「查看全部」→ 全屏列表 → 多选批量驳回。
// 断言重点是**判断力有没有上屏**，而不是「渲出了几个 div」：
//   1. 行首「中文名 + 代号」，名字取不到退回代号（MUST NOT 拼假名字）；
//   2. `refresh` 行必须自带「将覆盖既有锚」徽标 —— 它不是更温和的 create，会冲掉三处人工位；
//   3. 口径日可疑档各有各的话，`OK` 不出徽标；
//   4. 批量驳回的 `skipped` **必须逐条落到人眼里**（FR-007 明禁「折成一句 ok」）。
//
// mock 是**契约镜像**：待审集在内存，`reject` 按「该行现在是不是 PENDING」算 rejected/skipped
// （与 server 的条件更新同语义），🚫 不按调用序摆答案。「别的设备处置掉一行」由测试显式调
// `consumeExternally()` 触发 —— 那是一个真实事件，不是第 N 次调用。
//
// 🚨 **行定位一律钉进容器**：同一条待审在「我的」内嵌面板与全屏列表里各渲一次，而 profile
// 屏在导航栈里仍挂着 ⇒ 裸 `getByTestId('…-row-us:AOS')` strict mode 双命中（实撞）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const SUBMISSION_GLOB = '**/api/v1/optionsdesk/anchor-submissions**';
const SCREENSHOT_DIR = 'playwright-report/screenshots';

const SEED_ACCOUNT_ID = 'acc-e2e-072';
const SEED_ACCESS_TOKEN = 'access-e2e-072';
const SEED_REFRESH_TOKEN = 'refresh-e2e-072';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139072';

const seedAuthStore = `
  window.localStorage.setItem(
    'nvy-auth',
    JSON.stringify({
      state: {
        accountId: '${SEED_ACCOUNT_ID}',
        accessToken: '${SEED_ACCESS_TOKEN}',
        refreshToken: '${SEED_REFRESH_TOKEN}',
        displayName: '${SEED_DISPLAY_NAME}',
        phone: '${SEED_PHONE}',
      },
      version: 0,
    }),
  );
`;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

const fulfill = (route: Route, status: number, payload: unknown) =>
  route.fulfill({
    status,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(payload),
  });

interface MockSubmission {
  id: string;
  ticker: string;
  instrumentName: string | null;
  market: 'us' | 'hk';
  v: string;
  asof: string;
  method: string;
  confidence: string;
  note: string | null;
  disposition: 'create' | 'refresh';
  asofFlag: 'OK' | 'TODAY' | 'FUTURE' | 'NON_TRADING' | 'UNKNOWN';
  asofSuggested: string | null;
  asofNeedsAck: boolean;
  status: 'PENDING' | 'CONSUMED' | 'REJECTED';
  /** 详情专属：采纳会冲掉哪些人工位（与真实写入路径同一个纯函数算出）。 */
  fallbackPreview?: {
    ticker: string;
    slot: string;
    manualValue: string;
    fallbackValue: string | null;
  }[];
  /** 详情专属：本次采纳会不会什么都不写。 */
  willBeNoop?: boolean;
  /** 采纳后回执里的 statusFlipped（false = 半截态，锚已写但状态没翻）。 */
  flipsOnApprove?: boolean;
}

const SEED_ROWS: MockSubmission[] = [
  {
    id: '1',
    ticker: 'us:CFG',
    instrumentName: 'Citizens Financial Group',
    market: 'us',
    v: '49.3400',
    asof: '2026-08-30',
    method: 'weighted',
    confidence: '6.0',
    note: '按 2026Q2 报表重估',
    disposition: 'create',
    asofFlag: 'OK',
    asofSuggested: null,
    asofNeedsAck: false,
    status: 'PENDING',
  },
  {
    id: '2',
    ticker: 'hk:02359',
    instrumentName: '药明康德',
    market: 'hk',
    v: '62.0000',
    asof: '2026-08-29',
    method: 'dcf',
    confidence: '7.5',
    note: null,
    // 🚨 覆盖既有锚 —— 会冲掉三处人工位并把 confidence_source 翻 model。
    disposition: 'refresh',
    asofFlag: 'OK',
    asofSuggested: null,
    asofNeedsAck: false,
    status: 'PENDING',
    // sb-10：采纳会冲掉三处人工位，逐条列出（汇总成「3 处」掩盖的正是「哪一处」）。
    fallbackPreview: [
      { ticker: 'hk:02359', slot: 'v', manualValue: '58.0000', fallbackValue: '62.0000' },
      { ticker: 'hk:02359', slot: 'lLevel', manualValue: 'L2', fallbackValue: 'L3' },
      // L4 档无上限口径 ⇒ fallbackValue 为 null，屏上给「—」，🚫 不自造一个值。
      { ticker: 'hk:02359', slot: 'ceiling', manualValue: '70.0000', fallbackValue: null },
    ],
    willBeNoop: false,
  },
  {
    id: '3',
    ticker: 'us:AOS',
    // 名字取不到（该 ticker 未在行情库注册）⇒ 屏上退回代号，不拼假名字。
    instrumentName: null,
    market: 'us',
    v: '80.0000',
    asof: '2026-08-30',
    method: 'dcf',
    confidence: '7.5',
    note: null,
    disposition: 'create',
    asofFlag: 'NON_TRADING',
    asofSuggested: '2026-08-28',
    asofNeedsAck: true,
    status: 'PENDING',
  },
  {
    id: '4',
    ticker: 'us:KVUE',
    instrumentName: 'Kenvue',
    market: 'us',
    v: '24.8000',
    asof: '2026-09-02',
    method: 'dcf',
    confidence: '6.5',
    note: null,
    disposition: 'create',
    asofFlag: 'FUTURE',
    asofSuggested: '2026-08-31',
    asofNeedsAck: true,
    status: 'PENDING',
  },
  {
    id: '5',
    ticker: 'us:PCG',
    instrumentName: 'Pacific Gas & Electric',
    market: 'us',
    v: '17.5000',
    asof: '2026-08-28',
    method: 'sotp',
    confidence: '8.00',
    note: null,
    // sb-11：refresh 但四个模型事实逐值相同 ⇒ 什么都不会写 ⇒ **零警告**。
    disposition: 'refresh',
    asofFlag: 'OK',
    asofSuggested: null,
    asofNeedsAck: false,
    status: 'PENDING',
    fallbackPreview: [],
    willBeNoop: true,
  },
  {
    id: '6',
    ticker: 'us:MMM',
    instrumentName: '3M',
    market: 'us',
    v: '95.0000',
    // sb-3：日历没填到那一段 —— 不是「不是交易日」，是**没人知道**，故建议日解不出。
    asof: '2026-01-04',
    method: 'dcf',
    confidence: '6.00',
    note: null,
    disposition: 'create',
    asofFlag: 'UNKNOWN',
    asofSuggested: null,
    asofNeedsAck: true,
    status: 'PENDING',
  },
];

interface SubmissionMock {
  /** 模拟「这一行在别的设备上（或被 anchor-approve.sh）处置掉了」。 */
  consumeExternally: (id: string) => void;
  rejectPayloads: () => { ids: string[] }[];
  approvePayloads: () => { id: string; body: Record<string, unknown> }[];
}

async function installSubmissionMock(page: Page, seed: MockSubmission[]): Promise<SubmissionMock> {
  const rows = seed.map((r) => ({ ...r }));
  const rejectPayloads: { ids: string[] }[] = [];
  const approvePayloads: { id: string; body: Record<string, unknown> }[] = [];

  await page.route(SUBMISSION_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    if (method === 'OPTIONS') return void (await route.fulfill({ status: 204, headers: CORS }));

    const path = new URL(req.url()).pathname;

    if (path.endsWith('/reject') && method === 'POST') {
      const body = (req.postDataJSON() ?? {}) as { ids?: string[] };
      const ids = body.ids ?? [];
      rejectPayloads.push({ ids });
      // 与 server 同语义：**先按前置状态判**，PENDING 的才算驳回，其余进 skipped。
      const rejected: string[] = [];
      const skipped: string[] = [];
      for (const id of ids) {
        const row = rows.find((r) => r.id === id);
        if (row && row.status === 'PENDING') {
          row.status = 'REJECTED';
          rejected.push(id);
        } else {
          skipped.push(id);
        }
      }
      return void (await fulfill(route, 200, { rejected: rejected.length, skipped }));
    }

    // ── 采纳：口径日闸与 server 同语义 ──
    // 🚨 409 只回 `code` —— 服务端连 asofFlag / asofSuggested 一起抛了，但
    // `ProblemDetailFilter` 只透传白名单字段（code / freezeUntil / retryAfterSeconds /
    // invalidAttributes），那两样到不了客户端。mock 如实镜像这一点，否则测试会为一条
    // 客户端根本收不到的字段建立信心（045 EC-7 踩过同一处）。
    if (path.endsWith('/approve') && method === 'POST') {
      const id = path.split('/').slice(-2)[0] ?? '';
      const body = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      approvePayloads.push({ id, body });
      const row = rows.find((r) => r.id === id);
      if (!row)
        return void (await fulfill(route, 404, {
          code: 'NOT_FOUND',
          title: 'Not Found',
          status: 404,
        }));
      if (row.status !== 'PENDING') {
        return void (await fulfill(route, 409, {
          code: 'SUBMISSION_NOT_PENDING',
          title: 'Conflict',
          status: 409,
        }));
      }

      const ack = body['asofAck'] as 'shift' | 'accept' | undefined;
      const requestedAsof = (body['asof'] as string | undefined) ?? row.asof;
      // 审核方改过口径日 ⇒ 判的是**最终 asof**（FR-005）。本 mock 把「改过的日期」一律
      // 当作仍需确认，正是为了验「客户端此时拿不到建议日 ⇒ 只剩照发出口」。
      const needsAck = requestedAsof === row.asof ? row.asofNeedsAck : true;

      if (needsAck && ack === undefined) {
        return void (await fulfill(route, 409, {
          code: 'ASOF_SUSPECT',
          title: 'Conflict',
          status: 409,
        }));
      }
      if (needsAck && ack === 'shift' && row.asofSuggested === null) {
        return void (await fulfill(route, 409, {
          code: 'ASOF_SHIFT_UNRESOLVABLE',
          title: 'Conflict',
          status: 409,
        }));
      }

      const appliedAsof = ack === 'shift' && row.asofSuggested ? row.asofSuggested : requestedAsof;
      const flipped = row.flipsOnApprove !== false;
      if (flipped) row.status = 'CONSUMED';
      return void (await fulfill(route, 200, {
        action: row.willBeNoop ? 'noop' : row.disposition === 'refresh' ? 'update' : 'create',
        anchorId: `anchor-${row.id}`,
        ticker: row.ticker,
        appliedAsof,
        asofFlag: row.asofFlag,
        fallbackEntries: row.fallbackPreview ?? [],
        statusFlipped: flipped,
        coldStartExpected: row.disposition === 'create' && !row.willBeNoop,
      }));
    }

    // ── 详情：比列表多 fallbackPreview / willBeNoop ──
    const detailId = /\/anchor-submissions\/([^/]+)$/.exec(path)?.[1];
    if (method === 'GET' && detailId) {
      const row = rows.find((r) => r.id === detailId);
      if (!row)
        return void (await fulfill(route, 404, {
          code: 'NOT_FOUND',
          title: 'Not Found',
          status: 404,
        }));
      return void (await fulfill(route, 200, {
        ...row,
        submitter: 'friend2',
        reviewNote: null,
        consumedAnchorId: null,
        createdAt: '2026-08-31T02:00:00.000Z',
        updatedAt: '2026-08-31T02:00:00.000Z',
        fallbackPreview: row.fallbackPreview ?? [],
        willBeNoop: row.willBeNoop ?? false,
        existingConfidenceSource: row.disposition === 'refresh' ? 'manual' : null,
      }));
    }

    if (method === 'GET') {
      const pending = rows.filter((r) => r.status === 'PENDING');
      return void (await fulfill(route, 200, {
        items: pending.map((r) => ({
          ...r,
          submitter: 'friend2',
          reviewNote: null,
          consumedAnchorId: null,
          createdAt: '2026-08-31T02:00:00.000Z',
          updatedAt: '2026-08-31T02:00:00.000Z',
        })),
        total: pending.length,
        truncated: false,
      }));
    }

    await route.fallback();
  });

  return {
    consumeExternally: (id) => {
      const row = rows.find((r) => r.id === id);
      if (row) row.status = 'CONSUMED';
    },
    rejectPayloads: () => rejectPayloads,
    approvePayloads: () => approvePayloads,
  };
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  // GET /me 必拦（per mobile-e2e-hermetic）。isAdmin: true —— 审批栏只对管理员渲染。
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      status: 'ACTIVE',
      createdAt: '2026-05-25T00:00:00.000Z',
      isAdmin: true,
    },
    'GET',
  );
  await mockJson(page, REFRESH_URL, 200, {
    accountId: SEED_ACCOUNT_ID,
    accessToken: SEED_ACCESS_TOKEN,
    refreshToken: SEED_REFRESH_TOKEN,
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.log('[browser-console]', msg.text());
  });
  page.on('pageerror', (e) => console.log('[page-error]', e.message));
});

test.setTimeout(120_000);

test('072 T018 — 审批栏内嵌面板：中文名+代号 / 覆盖徽标 / 口径日徽标（FR-001, US1）', async ({
  page,
}) => {
  await installSubmissionMock(page, SEED_ROWS);

  await page.goto('/');
  // admin 默认落审批栏（可见集合首项）。
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId('optionsdesk-submission-panel-count')).toHaveText(
    String(SEED_ROWS.length),
  );

  const panel = page.getByTestId('optionsdesk-submission-panel');

  // ① 行首主位 = 中文名；名字取不到（us:AOS）退回**代号**，MUST NOT 拼假名字。
  await expect(panel.getByText('药明康德')).toBeVisible();
  await expect(panel.getByText('Citizens Financial Group')).toBeVisible();
  await expect(panel.getByText('AOS', { exact: true })).toBeVisible();

  // ② refresh 行自带「将覆盖既有锚」；create 行是中性文案 —— 两者 MUST NOT 同文案。
  await expect(panel.getByTestId('optionsdesk-submission-disposition-hk:02359')).toHaveText(
    '将覆盖既有锚',
  );
  await expect(panel.getByTestId('optionsdesk-submission-disposition-us:CFG')).toHaveText('将建锚');

  // ③ 口径日：可疑档出徽标且各说各的；OK 档**根本不渲染**徽标。
  await expect(panel.getByTestId('optionsdesk-submission-asof-us:AOS')).toHaveText(
    '口径日落在非交易日',
  );
  await expect(panel.getByTestId('optionsdesk-submission-asof-us:KVUE')).toHaveText('口径日在未来');
  await expect(panel.getByTestId('optionsdesk-submission-asof-us:CFG')).toHaveCount(0);

  await page.screenshot({ path: `${SCREENSHOT_DIR}/072-review-panel.png`, fullPage: true });
});

test('072 T018 — 批量驳回：只驳可见选中项 + skipped 逐条落到人眼里（FR-007, SC-001）', async ({
  page,
}) => {
  const mock = await installSubmissionMock(page, SEED_ROWS);

  await page.goto('/');
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible({ timeout: 90_000 });

  // 「查看全部」→ 全屏列表（期权台二级页栈，继承 MarketsRouteGuard）。
  await page.getByTestId('optionsdesk-submission-see-all').tap();
  await expect(page).toHaveURL(/anchor-submissions$/);
  await expect(page.getByTestId('optionsdesk-submission-count')).toContainText(
    `共 ${SEED_ROWS.length} 条待审`,
  );
  await expect(page.getByTestId('optionsdesk-submission-count')).toContainText('friend2');

  const list = page.getByTestId('optionsdesk-submission-list');

  // 多选态：勾两条（其中 us:AOS 会在我们脚下被别的设备处置掉）。
  await page.getByTestId('optionsdesk-submission-select-toggle').tap();
  await list.getByTestId('optionsdesk-submission-row-us:AOS').tap();
  await list.getByTestId('optionsdesk-submission-row-us:KVUE').tap();
  await expect(page.getByTestId('optionsdesk-submission-selected-count')).toHaveText('已选 2 项');

  // 🚨 真实竞态：别的设备（或 anchor-approve.sh）先把 us:AOS 采纳掉了。
  mock.consumeExternally('3');

  await page.getByTestId('optionsdesk-submission-reject').tap();
  await page.getByRole('button', { name: '驳回', exact: true }).last().tap();

  // 结局分两句：驳回成功 1 条 + 1 条在你操作前已被处置。**MUST NOT 折成一句 ok**。
  await expect(page.getByTestId('optionsdesk-submission-reject-done')).toHaveText('已驳回 1 条');
  await expect(page.getByTestId('optionsdesk-submission-reject-skipped')).toContainText('1 条');

  // 发出去的 ids 恰是屏上勾的那两条（不多不少）。
  expect(mock.rejectPayloads()).toHaveLength(1);
  expect(mock.rejectPayloads()[0]?.ids.sort()).toEqual(['3', '4']);

  // 列表当场刷新：被驳回的 KVUE 与被外部采纳的 AOS 都不在了，剩下两条。
  await expect(list.getByTestId('optionsdesk-submission-row-us:KVUE')).toHaveCount(0);
  await expect(list.getByTestId('optionsdesk-submission-row-us:AOS')).toHaveCount(0);
  await expect(list.getByTestId('optionsdesk-submission-row-us:CFG')).toBeVisible();

  await page.screenshot({ path: `${SCREENSHOT_DIR}/072-reject-batch.png`, fullPage: true });
});

test('072 T018 — 市场 chips 单选：切走后看不见的选中项不参与驳回', async ({ page }) => {
  const mock = await installSubmissionMock(page, SEED_ROWS);

  await page.goto('/');
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('optionsdesk-submission-see-all').tap();
  await expect(page.getByTestId('optionsdesk-submission-filter-all')).toBeVisible();

  const list = page.getByTestId('optionsdesk-submission-list');
  await page.getByTestId('optionsdesk-submission-select-toggle').tap();
  await list.getByTestId('optionsdesk-submission-row-hk:02359').tap(); // 港股那条
  await list.getByTestId('optionsdesk-submission-row-us:CFG').tap();
  await expect(page.getByTestId('optionsdesk-submission-selected-count')).toHaveText('已选 2 项');

  // 切到「美股」——港股那条离开视野。计数当场退回 1：看不见的选中项不参与驳回。
  await page.getByTestId('optionsdesk-submission-filter-us').tap();
  await expect(page.getByTestId('optionsdesk-submission-selected-count')).toHaveText('已选 1 项');

  await page.getByTestId('optionsdesk-submission-reject').tap();
  await page.getByRole('button', { name: '驳回', exact: true }).last().tap();

  // 只发了屏上那一条 —— 「屏上选了 1 条、实际驳回 2 条」是不可接受的偏差。
  // ⚠️ 先等请求真的发出去（`expect.poll`）再读载荷：tap 之后同步读数组只会读到空，
  // 那种红长得像「载荷不对」，其实是「还没发」。
  await expect.poll(() => mock.rejectPayloads().length).toBe(1);
  expect(mock.rejectPayloads()[0]?.ids).toEqual(['1']);
  await expect(page.getByTestId('optionsdesk-submission-reject-done')).toHaveText('已驳回 1 条');
});

// ─── T019 审批详情 + 复述闸 + 三出口（FR-002, FR-005; US2, US3） ──────────────────

/** 进详情：审批栏面板 →「查看全部」→ 全屏列表 → 点该行。 */
async function openDetail(page: Page, ticker: string) {
  await page.goto('/');
  await expect(page.getByTestId('optionsdesk-submission-panel')).toBeVisible({ timeout: 90_000 });
  await page.getByTestId('optionsdesk-submission-see-all').tap();
  const list = page.getByTestId('optionsdesk-submission-list');
  await list.getByTestId(`optionsdesk-submission-row-${ticker}`).tap();
  await expect(page.getByTestId('optionsdesk-submission-detail')).toBeVisible({ timeout: 30_000 });
}

test('072 T019 — 详情：refresh 逐条列出会被冲掉的人工位（sb-10, US2）', async ({ page }) => {
  await installSubmissionMock(page, SEED_ROWS);
  await openDetail(page, 'hk:02359');

  const warning = page.getByTestId('optionsdesk-submission-fallback-warning');
  await expect(warning).toBeVisible();
  // 🚨 判据是**逐条**：三处人工位各自成行，而不是一句「将清掉 3 处」。
  await expect(page.getByTestId('optionsdesk-submission-fallback-v')).toContainText('58.0000');
  await expect(page.getByTestId('optionsdesk-submission-fallback-lLevel')).toContainText('L2');
  // L4 档无上限口径 ⇒ fallbackValue 为 null ⇒ 屏上「—」，🚫 不自造一个值。
  await expect(page.getByTestId('optionsdesk-submission-fallback-ceiling')).toContainText('—');
  // 置信度来源翻 model 这件事也必须说出来（此后置信度在 App 里改不动）。
  await expect(warning).toContainText('model');
  // 采纳按钮改口为「采纳并覆盖」——「采纳」二字不足以表达它会冲掉东西。
  await expect(page.getByTestId('optionsdesk-submission-detail-approve')).toHaveText('采纳并覆盖');
});

test('072 T019 — 详情：willBeNoop ⇒ 零警告（sb-11）', async ({ page }) => {
  await installSubmissionMock(page, SEED_ROWS);
  await openDetail(page, 'us:PCG');

  // 同样是 refresh，但逐值相同 ⇒ **不出**人工位警告，改出「什么都不会写」。
  await expect(page.getByTestId('optionsdesk-submission-fallback-warning')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-submission-noop-notice')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-submission-detail-approve')).toHaveText(
    '采纳（无写入）',
  );
});

test('072 T019 — 口径日闸三出口：改送前一交易日（sb-2, sb-5; US3）', async ({ page }) => {
  const mock = await installSubmissionMock(page, SEED_ROWS);
  await openDetail(page, 'us:AOS');

  // 采纳 → 服务端 fail-closed 409 → 三出口对话框（**不是**一句错误提示）。
  await page.getByTestId('optionsdesk-submission-detail-approve').tap();
  const gate = page.getByTestId('optionsdesk-submission-asof-gate');
  await expect(gate).toBeVisible();
  // 复述闸：把「要改的到底是哪条估值」原样摆回来。
  await expect(gate).toContainText('us:AOS');
  await expect(gate).toContainText('2026-08-30');
  await expect(gate).toContainText('80.0000');

  await expect(page.getByTestId('optionsdesk-submission-asof-exit-shift')).toContainText(
    '2026-08-28',
  );
  await expect(page.getByTestId('optionsdesk-submission-asof-exit-accept')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-submission-asof-exit-cancel')).toBeVisible();

  await page.getByTestId('optionsdesk-submission-asof-exit-shift').tap();

  // 回执：落库口径日 = 建议日（≠ 提交行的 asof —— 这条差异是「被改过」的唯一痕迹）。
  const receipt = page.getByTestId('optionsdesk-submission-receipt');
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('2026-08-28');
  await expect(receipt).toContainText('已排队'); // create ⇒ 排冷启动

  await expect.poll(() => mock.approvePayloads().length).toBe(2);
  // 第一发不带 ack（fail-closed：撞上可疑档就该被挡下），第二发才带 shift。
  expect(mock.approvePayloads()[0]?.body['asofAck']).toBeUndefined();
  expect(mock.approvePayloads()[1]?.body['asofAck']).toBe('shift');
});

test('072 T019 — 口径日闸：日历解不出 ⇒「改送」出口缺席（sb-3, sb-6; US3）', async ({ page }) => {
  const mock = await installSubmissionMock(page, SEED_ROWS);
  await openDetail(page, 'us:MMM');

  await page.getByTestId('optionsdesk-submission-detail-approve').tap();
  await expect(page.getByTestId('optionsdesk-submission-asof-gate')).toBeVisible();

  // 🚨 整个出口**不渲染** —— 不是 disabled。系统不猜，多一个点不动的按钮只会让人以为自己没选对。
  await expect(page.getByTestId('optionsdesk-submission-asof-exit-shift')).toHaveCount(0);
  await expect(page.getByTestId('optionsdesk-submission-asof-exit-accept')).toBeVisible();
  await expect(page.getByTestId('optionsdesk-submission-asof-exit-cancel')).toBeVisible();
  // 「判不了」与「不是交易日」是两句话（UNKNOWN 不等于没问题，也不等于非交易日）。
  await expect(page.getByTestId('optionsdesk-submission-asof-gate')).toContainText('判不了');

  await page.getByTestId('optionsdesk-submission-asof-exit-accept').tap();
  const receipt = page.getByTestId('optionsdesk-submission-receipt');
  await expect(receipt).toBeVisible();
  // 照发 ⇒ 落库口径日仍是原日期（没人替他猜一个）。
  await expect(receipt).toContainText('2026-01-04');
  await expect.poll(() => mock.approvePayloads().length).toBe(2);
  expect(mock.approvePayloads()[1]?.body['asofAck']).toBe('accept');
});

test('072 T019 — 半截态回执：锚已写但状态没翻，明说不要重试（sb-13）', async ({ page }) => {
  await installSubmissionMock(
    page,
    SEED_ROWS.map((r) => (r.id === '1' ? { ...r, flipsOnApprove: false } : r)),
  );
  await openDetail(page, 'us:CFG');

  await page.getByTestId('optionsdesk-submission-detail-approve').tap();

  const receipt = page.getByTestId('optionsdesk-submission-receipt');
  await expect(receipt).toBeVisible();
  // 🚨 半截态**不是失败**：锚已写入照常显示，另起一段说状态没翻 + 不要重试。
  await expect(receipt).toContainText('锚已写入');
  await expect(page.getByTestId('optionsdesk-submission-receipt-half')).toContainText('不要重试');
});
