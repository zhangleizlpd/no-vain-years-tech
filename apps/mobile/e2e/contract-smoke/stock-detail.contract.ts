/**
 * 014 stock-detail 契约冒烟（PR2 §V 第二层）。
 *
 * 用**生成的** @nvy/api-client 函数（Orval，消费端真实代码路径）打**真 server**（harness boot 的
 * testcontainers 后端）验 014 唯一新增 server 面 `watchlist-status` 端到端 + 真落库 + 契约对齐，
 * 并覆盖它与 013 加自选 / 编辑分组加自定义组的跨流程派生：
 *   ① 未加 → watchlist-status inWatchlist=false, memberships=[]（未知 symbol 非 404, T003 state_branch）；
 *   ② 加「自选」组（013 EP7）→ inWatchlist=true 且 memberships 含自选组归属（窄义，D1）；
 *   ③ 经编辑分组加自定义组（013 EP7）→ memberships +1（含两组）、inWatchlist 仍 true（自定义组不改窄义态）；
 *   ④ round-trip 读回确认派生持久一致（真 DB，非 mutation 响应回声）。
 *
 * 边界：014 server **零 marketdata 耦合**（ADR-0048）——详情/K线/报价由 mobile client 直调 015 EP3/EP4，
 * 属 **015 自己的 contract-smoke** 责任（种 marketdata + 断 EP3/EP4，见 015 tasks.md follow-up）。本 spec
 * 不种 marketdata、不打 015 读端点（watchlist 仅存 raw market+code，天然可跑空 marketdata 库）。
 * 末尾删本 spec 落的 items + 自定义组，保持同套件后续 spec 的 boot 内幂等。
 */
import assert from 'node:assert/strict';
import {
  GroupItemSystemKind,
  watchlistGroupsControllerAddItem,
  watchlistGroupsControllerCreate,
  watchlistGroupsControllerDelete,
  watchlistItemsControllerDelete,
  watchlistStatusControllerStatus,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'stock-detail (014)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const MARKET = 'cn';
  const CODE = '600519';

  // ① 未加 → watchlist-status inWatchlist=false, memberships=[]（未知/未加 symbol 非 404）。
  const status0 = await watchlistStatusControllerStatus(MARKET, CODE, cfg);
  assert.equal(status0.status, 200, `status expected 200, got ${status0.status}`);
  assert.equal(status0.data.inWatchlist, false, 'fresh: not in watchlist');
  assert.deepEqual(status0.data.memberships, [], 'fresh: no memberships');

  // 建自定义组 → 首写 materialize 系统组（虚拟 → 真实 id），并拿「自选」组 + 自定义组真实 id。
  const created = await watchlistGroupsControllerCreate({ name: '契约详情组' }, cfg);
  assert.equal(created.status, 200, `create expected 200, got ${created.status}`);
  const watchlist = created.data.groups.find((g) => g.systemKind === GroupItemSystemKind.watchlist);
  const custom = created.data.groups.find((g) => g.name === '契约详情组');
  assert.ok(watchlist, 'watchlist system group materialized');
  assert.ok(custom, 'custom group present');

  // ② 加「自选」组（013 EP7）→ watchlist-status inWatchlist=true + memberships 含自选组归属（窄义）。
  const addWatch = await watchlistGroupsControllerAddItem(
    watchlist.id,
    { market: MARKET, code: CODE },
    cfg,
  );
  assert.equal(addWatch.status, 200, `add to watchlist expected 200, got ${addWatch.status}`);
  const watchItem = addWatch.data.items.find((it) => it.market === MARKET && it.code === CODE);
  assert.ok(watchItem, 'item persisted under watchlist group');

  const status1 = await watchlistStatusControllerStatus(MARKET, CODE, cfg);
  assert.equal(status1.data.inWatchlist, true, 'after add: inWatchlist=true (窄义系统自选组)');
  const m1 = status1.data.memberships.find((m) => m.groupId === watchlist.id);
  assert.ok(m1, 'memberships 含自选组归属');
  assert.equal(m1.itemId, watchItem.id, 'membership itemId 对齐落库 item id（精确删用，D1）');

  // ③ 经编辑分组加自定义组（013 EP7）→ memberships +1（含两组）、inWatchlist 仍 true。
  const addCustom = await watchlistGroupsControllerAddItem(
    custom.id,
    { market: MARKET, code: CODE },
    cfg,
  );
  assert.equal(addCustom.status, 200, `add to custom expected 200, got ${addCustom.status}`);
  const customItem = addCustom.data.items.find((it) => it.market === MARKET && it.code === CODE);
  assert.ok(customItem, 'item persisted under custom group');

  const status2 = await watchlistStatusControllerStatus(MARKET, CODE, cfg);
  assert.equal(
    status2.data.inWatchlist,
    true,
    'after custom add: inWatchlist 仍 true（自定义组不改窄义态）',
  );
  assert.equal(status2.data.memberships.length, 2, 'memberships +1（自选 + 自定义两组）');
  const groupIds = status2.data.memberships.map((m) => m.groupId).sort();
  assert.deepEqual(groupIds, [watchlist.id, custom.id].sort(), 'memberships 覆盖自选组 + 自定义组');

  // ④ round-trip 读回（真 DB 派生一致，非 mutation 响应回声）。
  const roundTrip = await watchlistStatusControllerStatus(MARKET, CODE, cfg);
  assert.equal(roundTrip.data.memberships.length, 2, 'memberships 持久一致（fresh GET）');
  assert.equal(roundTrip.data.inWatchlist, true, 'inWatchlist 持久一致');

  // ⑤ cleanup：删两 item + 删自定义组（保持 boot 内幂等，不污染后续 spec）。
  const delWatchItem = await watchlistItemsControllerDelete(watchItem.id, cfg);
  assert.equal(
    delWatchItem.status,
    200,
    `cleanup watch item expected 200, got ${delWatchItem.status}`,
  );
  const delCustomItem = await watchlistItemsControllerDelete(customItem.id, cfg);
  assert.equal(
    delCustomItem.status,
    200,
    `cleanup custom item expected 200, got ${delCustomItem.status}`,
  );
  const delGroup = await watchlistGroupsControllerDelete(custom.id, cfg);
  assert.equal(delGroup.status, 200, `cleanup group expected 200, got ${delGroup.status}`);
}
