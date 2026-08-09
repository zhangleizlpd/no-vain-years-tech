/**
 * 013 watchlist 契约冒烟（PR2 §V 第二层）。
 *
 * 用**生成的** @nvy/api-client 函数（Orval，消费端真实代码路径）打**真 server**（harness
 * boot 的 testcontainers 后端）验自选核心写链 + 真落库 + 契约对齐：
 *   ① 新账号 list → 投影 2 虚拟系统组（自选 / 持仓，零写库）；
 *   ② 建自定义组 → 首写 materialize 2 系统组（虚拟 → 真实 id）+ 自定义组 type=custom；
 *   ③ 加自选（market+code）→ ItemListResponse 含新条、raw market/code（证经真栈落库）；
 *   ④ 固顶 → pinned=true 且排到列首（固顶区常驻顶, FR-S05 经客户端契约对齐）；
 *   ⑤ listItems 读回确认持久化（真 DB round-trip）。
 *
 * 这正是 hermetic Playwright（mock 即假设契约）与 server IT（不经生成客户端）都覆盖不到的缝。
 * 末尾删本 spec 落的 item + 自定义组，保持同套件后续 spec 的 boot 内幂等。
 */
import assert from 'node:assert/strict';
import {
  GroupItemSystemKind,
  GroupItemType,
  watchlistGroupsControllerAddItem,
  watchlistGroupsControllerCreate,
  watchlistGroupsControllerDelete,
  watchlistGroupsControllerList,
  watchlistGroupsControllerListItems,
  watchlistItemsControllerDelete,
  watchlistItemsControllerUpdate,
} from '@nvy/api-client';

import type { RealBackendCtx } from '../_support/real-backend-harness';

export const name = 'watchlist (013)';

export async function run(ctx: RealBackendCtx): Promise<void> {
  const cfg = { baseURL: ctx.api, headers: { authorization: `Bearer ${ctx.accessToken}` } };
  const MARKET = 'cn';
  const CODE = '600519';

  // ① 新账号 list → 2 虚拟系统组（自选 / 持仓），各 itemCount 0（GET 零写库, D2）。
  const initial = await watchlistGroupsControllerList(cfg);
  assert.equal(initial.status, 200);
  const watchlist0 = initial.data.groups.find(
    (g) => g.systemKind === GroupItemSystemKind.watchlist,
  );
  const holdings0 = initial.data.groups.find((g) => g.systemKind === GroupItemSystemKind.holdings);
  assert.ok(watchlist0, 'watchlist system group projected');
  assert.ok(holdings0, 'holdings system group projected');
  assert.equal(watchlist0.type, GroupItemType.system, 'watchlist is a system group');

  // ② 建自定义组 → 首写 materialize 系统组（虚拟 → 真实 id）+ 自定义组 type=custom。
  const created = await watchlistGroupsControllerCreate({ name: '契约冒烟组' }, cfg);
  assert.equal(created.status, 200, `create expected 200, got ${created.status}`);
  const custom = created.data.groups.find((g) => g.name === '契约冒烟组');
  assert.ok(custom, 'custom group present in returned list');
  assert.equal(custom.type, GroupItemType.custom, 'custom group type=custom');
  const watchlist = created.data.groups.find((g) => g.systemKind === GroupItemSystemKind.watchlist);
  assert.ok(watchlist, 'watchlist group materialized after first write');

  // ③ 加自选（market+code）→ ItemListResponse 含新条，raw market/code（真栈落库）。
  const added = await watchlistGroupsControllerAddItem(
    watchlist.id,
    { market: MARKET, code: CODE },
    cfg,
  );
  assert.equal(added.status, 200, `add expected 200, got ${added.status}`);
  const item = added.data.items.find((it) => it.market === MARKET && it.code === CODE);
  assert.ok(item, 'added item present in returned items list (persisted)');
  assert.equal(item.market, MARKET, 'server returns raw market (no mapping, #302 vocab)');
  assert.equal(item.code, CODE, 'server returns raw code');
  assert.equal(item.pinned, false, 'fresh item not pinned');

  // ④ 固顶 → pinned=true 且排到列首（固顶区常驻顶, FR-S05）。
  const pinned = await watchlistItemsControllerUpdate(item.id, { pinned: true }, cfg);
  assert.equal(pinned.status, 200, `pin expected 200, got ${pinned.status}`);
  const pinnedItem = pinned.data.items.find((it) => it.id === item.id);
  assert.ok(pinnedItem, 'pinned item present');
  assert.equal(pinnedItem.pinned, true, 'item now pinned');
  assert.equal(pinned.data.items[0]?.id, item.id, 'pinned item sorts to top (FR-S05)');

  // ⑤ listItems 读回确认持久化（真 DB round-trip，非 mutation 响应回声）。
  const listed = await watchlistGroupsControllerListItems(watchlist.id, cfg);
  assert.equal(listed.status, 200);
  const roundTrip = listed.data.items.find((it) => it.id === item.id);
  assert.ok(roundTrip, 'item persisted (round-trip via fresh GET)');
  assert.equal(roundTrip.pinned, true, 'pin persisted to DB');

  // ⑥ cleanup：删 item + 删自定义组（保持 boot 内幂等，不污染后续 spec）。
  const delItem = await watchlistItemsControllerDelete(item.id, cfg);
  assert.equal(delItem.status, 200, `cleanup item delete expected 200, got ${delItem.status}`);
  const delGroup = await watchlistGroupsControllerDelete(custom.id, cfg);
  assert.equal(delGroup.status, 200, `cleanup group delete expected 200, got ${delGroup.status}`);
}
