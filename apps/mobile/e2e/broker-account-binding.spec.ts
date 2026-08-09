import { expect, test, type Page, type Route } from '@playwright/test';

import { mockJson } from './_support/api-mock';

// 012-broker-account-binding — Expo Web e2e（hermetic mock，进 runtime-smoke 门）。
//
// 镜像 011 stock-market-access.spec 的 stateful page.route 范式（mockJson 静态不够：
// 绑定 / 删除后需 GET 返新态对账）。覆盖 PR2 三页流转（US4/US5/US6）：
//   US4: 列表默认账户置顶（系统默认 tag）+ 默认行无删除入口。
//   US5: 新建 → 页 C 底部 sheet（搜索 + A-Z，无「开户」按钮 / 无能力标签 SC-M05）→
//        选中回填页 B → 填客户号 →「绑定」→ 回列表含新条（脱敏客户号 SC-M02）。
//   US5.5: 重复绑定同 {brokerCode, clientNo} → server 409 → 页 B 行内红框（bindErrorMessage）。
//   US6: 已绑行删除（二次确认 ConfirmModal → 乐观移除）。
//
// 三页流转 against PR1 已 ship 的 server 契约（openapi 锁定 → 此 mock 镜像真后端响应形态，
// per 类 2 流程纪律②；refreshToken 由 SDK 拦截器逻辑要求 → mock REFRESH_URL 200）。
//
// Auth seeded via addInitScript（nvy-auth zustand-persist，同 011/settings-shell）。
// URL 断言用 web-stripped 路径（expo-router web 剥 (group)/ 段）。
// getByRole 收窄 stacked screen（per memory playwright_expo_stacked_screen_locator_collision）。
// 删除走「删除块 dispatchEvent('click')」而非真手势：SwipeRow 的 reanimated Pan 在 headless
// Playwright web 下 worklet/pointer 序列非确定（手势 reveal 是 presentational，per mono 测试分层）；
// 直接 dispatch click 到揭示的 accessibilityLabel='删除' Pressable 验「删除 → 二次确认 → 乐观移除」行为链。
// **本地跑前杀 :3000 nx serve 父进程**（per memory nx_serve_respawns_3000_poisons_seed_e2e）。

const ME_URL = '**/api/v1/accounts/me';
const REFRESH_URL = '**/api/v1/accounts/refresh-token';
const BROKER_URL_GLOB = '**/api/v1/portfolio/broker-accounts**';
const SCREENSHOT_DIR = 'runtime-debug/2026-06-02-broker-account-binding';

const SEED_ACCOUNT_ID = 'acc-e2e-012';
const SEED_REFRESH_TOKEN = 'refresh-e2e-012';
const SEED_ACCESS_TOKEN = 'access-e2e-012';
const SEED_DISPLAY_NAME = '小明';
const SEED_PHONE = '+8613900139012';

// 测试用券商（镜像 server/client broker-catalog 名称，e2e 不依赖真后端字典）。
const HAITONG = { code: 'htzq', name: '海通证券', initial: 'H' };
const CLIENT_NO = '31192800002466'; // >8 字符 → maskClientNo 前4+****+后4。
const MASKED = '3119****2466';
const CREATED_AT = '2026-06-02T08:00:00.000Z';

// brokerName 查名表（mock GET 合成已绑行需返中文名，对齐 server buildBrokerAccountList merge）。
const BROKER_NAME: Record<string, string> = {
  dfcf: '东方财富',
  gfzq: '广发证券',
  gtja: '国泰君安',
  gxzq: '国信证券',
  htzq: '海通证券',
  htai: '华泰证券',
  pazq: '平安证券',
  swhy: '申万宏源',
  yhzq: '银河证券',
  zszq: '招商证券',
  zxzq: '中信证券',
  zjgs: '中金公司',
};

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
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': '*',
};

interface BoundRow {
  id: string;
  brokerCode: string;
  clientNo: string;
}

// stateful broker mock：GET 返「默认置顶 + 已绑行」；POST 唯一键(brokerCode+clientNo)冲突→409
// （镜像 server P2002→BROKER_ACCOUNT_DUPLICATE）；DELETE 按 id 删行（id===accountId→400
// 默认不可删；未命中→404）。返回 counter 供「无副作用」类断言（本 spec 未用，留扩展位）。
async function installBrokerMock(page: Page, initial: BoundRow[] = []) {
  const rows: BoundRow[] = initial.map((r) => ({ ...r }));
  let nextId = 1000;
  const counter = { post: 0, del: 0 };

  const buildList = () => ({
    accounts: [
      {
        id: SEED_ACCOUNT_ID,
        brokerCode: null,
        brokerName: '默认账户',
        clientNo: null,
        isDefault: true,
        createdAt: null,
      },
      ...rows.map((r) => ({
        id: r.id,
        brokerCode: r.brokerCode,
        brokerName: BROKER_NAME[r.brokerCode] ?? r.brokerCode,
        clientNo: r.clientNo,
        isDefault: false,
        createdAt: CREATED_AT,
      })),
    ],
  });

  const fulfillJson = (route: Route, status: number, payload: unknown) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify(payload),
    });

  await page.route(BROKER_URL_GLOB, async (route: Route) => {
    const req = route.request();
    const method = req.method();
    const pathname = new URL(req.url()).pathname;
    // DELETE 形态：.../broker-accounts/<id>（尾段非 broker-accounts 即带 id）。
    const tail = decodeURIComponent(pathname.split('/').pop() ?? '');
    const hasId = tail !== 'broker-accounts';

    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }

    if (method === 'GET') {
      await fulfillJson(route, 200, buildList());
      return;
    }

    if (method === 'POST') {
      counter.post += 1;
      const { brokerCode, clientNo } = (req.postDataJSON() ?? {}) as {
        brokerCode?: string;
        clientNo?: string;
      };
      const dup = rows.some((r) => r.brokerCode === brokerCode && r.clientNo === clientNo);
      if (dup) {
        await fulfillJson(route, 409, {
          status: 409,
          title: 'Broker account already bound',
          code: 'BROKER_ACCOUNT_DUPLICATE',
        });
        return;
      }
      const row: BoundRow = {
        id: String(nextId++),
        brokerCode: brokerCode ?? '',
        clientNo: clientNo ?? '',
      };
      rows.push(row);
      await fulfillJson(route, 201, {
        id: row.id,
        brokerCode: row.brokerCode,
        brokerName: BROKER_NAME[row.brokerCode] ?? row.brokerCode,
        clientNo: row.clientNo,
        isDefault: false,
        createdAt: CREATED_AT,
      });
      return;
    }

    if (method === 'DELETE' && hasId) {
      counter.del += 1;
      if (tail === SEED_ACCOUNT_ID) {
        await fulfillJson(route, 400, {
          status: 400,
          title: 'Default account is not deletable',
          code: 'DEFAULT_ACCOUNT_NOT_DELETABLE',
        });
        return;
      }
      const idx = rows.findIndex((r) => r.id === tail);
      if (idx === -1) {
        await fulfillJson(route, 404, { status: 404, title: 'Not Found', code: 'NOT_FOUND' });
        return;
      }
      rows.splice(idx, 1);
      await route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*' } });
      return;
    }

    await route.fallback();
  });

  return counter;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(seedAuthStore);
  await mockJson(
    page,
    ME_URL,
    200,
    {
      accountId: SEED_ACCOUNT_ID,
      phone: SEED_PHONE,
      displayName: SEED_DISPLAY_NAME,
      bio: null,
      status: 'ACTIVE',
    },
    'GET',
  );
  // 防 authed 401 触发 refresh 拦截器误登出（per memory authed_business_401_triggers_refresh_interceptor）。
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

async function bootToProfile(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('tab', { name: '我的' })).toBeVisible({ timeout: 90_000 });
}

// 设置 → 投资设置 Card「券商账户」(012 翻 live) → 股票账户列表页。
async function enterBrokerList(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings$/, { timeout: 10_000 });
  const brokerEntry = page.getByRole('button', { name: '券商账户', exact: true });
  await expect(brokerEntry).toBeEnabled();
  await brokerEntry.tap();
  await expect(page).toHaveURL(/\/settings\/broker-accounts$/, { timeout: 10_000 });
}

// 列表「新建」→ 页 C 选券商 → 回页 B 填客户号 →「绑定」。
async function bindBroker(page: Page, broker: { name: string }, clientNo: string) {
  await page.getByRole('button', { name: '新建', exact: true }).tap();
  await expect(page).toHaveURL(/\/settings\/broker-accounts\/bind$/, { timeout: 10_000 });

  // 开页 C 底部 sheet。
  await page.getByRole('button', { name: '选择券商', exact: true }).tap();
  // sheet 开 = 搜索条出现；SC-M05：无「开户」按钮 + A-Z 索引在场。
  await expect(page.getByPlaceholder('搜索券商名称 / 简拼')).toBeVisible();
  await expect(page.getByRole('button', { name: '开户' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: `跳到 ${HAITONG.initial}` })).toBeVisible();

  // 选中券商 → 回填页 B（sheet 关闭，行内显示券商名）。
  await page.getByRole('button', { name: broker.name, exact: true }).tap();
  await expect(page.getByPlaceholder('搜索券商名称 / 简拼')).toBeHidden();

  // 填客户号 → 「绑定」enabled。
  await page.getByLabel('客户号', { exact: true }).fill(clientNo);
  const submit = page.getByRole('button', { name: '绑定', exact: true });
  await expect(submit).toBeEnabled();
  await submit.tap();
}

// ─── US4 + US5 + US6：默认置顶 → 绑定 → 脱敏 → 二次确认删除 ──────────────────────

test('US4/5/6 — 默认置顶(无删除) → 选券商绑定(脱敏入列) → 二次确认删除', async ({ page }) => {
  await installBrokerMock(page, []);
  await bootToProfile(page);
  await enterBrokerList(page);

  // US4：仅默认账户置顶（系统默认 tag）+ 默认行无删除入口（无「删除」块）。
  await expect(page.getByText('系统默认')).toBeVisible();
  await expect(page.getByText('本账号 · 未归类持仓的默认归属')).toBeVisible();
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us4-default-only.png`, fullPage: true });

  // US5：新建 → 页 C 选券商 → 填客户号 → 绑定 → 回列表含脱敏新条（SC-M02）。
  await bindBroker(page, HAITONG, CLIENT_NO);
  await expect(page).toHaveURL(/\/settings\/broker-accounts$/, { timeout: 10_000 });
  await expect(page.getByText(HAITONG.name)).toBeVisible();
  await expect(page.getByText('已绑定')).toBeVisible();
  await expect(page.getByText(MASKED)).toBeVisible();
  // 明文客户号绝不上屏（脱敏在客户端，SC-M02）。
  await expect(page.getByText(CLIENT_NO)).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-bound-masked.png`, fullPage: true });

  // US6：左滑揭示的删除块 → 二次确认 → 乐观移除。删除前恰一「删除」块（已绑行，默认行无）。
  const deleteAction = page.getByRole('button', { name: '删除' });
  await expect(deleteAction).toHaveCount(1);
  // 删除块被行内容覆盖层遮挡（translateX=0 时 z-order 盖住）→ 坐标点击会命中覆盖层而非删除块，
  // force 只跳过 actionability 检查不改坐标命中。RN-Web Pressable 的 onPress 绑在 DOM click 上 →
  // dispatchEvent('click') 直达目标元素触发 onPress，绕开遮挡（手势 reveal 本身是 presentational）。
  await deleteAction.dispatchEvent('click');

  // ConfirmModal 弹出。
  await expect(page.getByText('确认删除该券商账户？')).toBeVisible();
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us6-confirm-modal.png`, fullPage: true });
  // 弹窗内确认「删除」：此刻 DOM 内 2 个「删除」（行内删除块 + 弹窗确认），弹窗后渲染 → .last()。
  await page.getByRole('button', { name: '删除' }).last().click();

  // 乐观移除 + GET 对账：已绑行消失，回到仅默认态。
  await expect(page.getByText(MASKED)).toHaveCount(0);
  await expect(page.getByText('已绑定')).toHaveCount(0);
  await expect(page.getByText('系统默认')).toBeVisible();
  await expect(page.getByRole('button', { name: '删除' })).toHaveCount(0);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us6-removed.png`, fullPage: true });
});

// ─── US5.5：重复绑定同券商+客户号 → 409 → 页 B 行内红框 ─────────────────────────

test('US5.5 — 重复绑定同 {券商,客户号} → 409 → 页 B 行内重复提示(无 navigation)', async ({
  page,
}) => {
  // 预置一条已绑（与稍后提交同键）→ 第二次绑定即 dup。
  await installBrokerMock(page, [{ id: '900', brokerCode: HAITONG.code, clientNo: CLIENT_NO }]);
  await bootToProfile(page);
  await enterBrokerList(page);

  // 预置行可见（脱敏）。
  await expect(page.getByText(MASKED)).toBeVisible();

  // 新建 → 选同券商 → 填同客户号 → 绑定 → server 409。
  await bindBroker(page, HAITONG, CLIENT_NO);

  // 行内重复提示 + 停在页 B（router.back 未触达）。
  await expect(page.getByText('该券商账户已绑定，请勿重复添加')).toBeVisible();
  await expect(page).toHaveURL(/\/settings\/broker-accounts\/bind$/);
  await page.screenshot({ path: `${SCREENSHOT_DIR}/us5-dup-inline-error.png`, fullPage: true });
});
