/**
 * Throttler 桶分组常量 —— @SkipThrottle 反污染共享真相源。
 *
 * `@nestjs/throttler` v6: module `throttlers[]` 里**每个** throttler 默认对**每条**
 * 受 ThrottlerGuard 的路由生效, 除非该路由 `@SkipThrottle` 显式跳过。故每新增一组
 * throttler, 既有路由都须跳过它, 否则被新桶 (更紧 limit + 共享 key) 误限流
 * (如 GET /me 被 del-code-account 1/60s 拖垮)。这里按 feature 分组, 路由 `@SkipThrottle`
 * 时 spread 非己分组, 避免每路由手列十余条 (003 起 5 桶 → 004 起 17 桶)。
 *
 * 放 security/ (平台层) 因 account + auth 两侧 controller 都需引用 (单向 import 合规)。
 */
export const DEFAULT_BUCKET: Record<string, boolean> = { default: true };

// 001 phone-sms 发码
export const SMS_CODE_BUCKETS: Record<string, boolean> = {
  'sms-phone-24h': true,
  'sms-ip-24h': true,
};

// 002 /me profile
export const ME_BUCKETS: Record<string, boolean> = { 'me-get': true, 'me-patch': true };

// 003 token refresh / logout-all
export const TOKEN_BUCKETS: Record<string, boolean> = {
  'refresh-ip': true,
  'refresh-token': true,
  'logout-all-ip': true,
  'logout-all-account': true,
};

// 004 注销发码 (EP1, authed)
export const DEL_CODE_BUCKETS: Record<string, boolean> = {
  'del-code-account': true,
  'del-code-ip': true,
};

// 004 注销提交 (EP2, authed)
export const DEL_SUBMIT_BUCKETS: Record<string, boolean> = {
  'del-submit-account': true,
  'del-submit-ip': true,
};

// 004 撤销发码 (EP3, public phone-hash)
export const CANCEL_CODE_BUCKETS: Record<string, boolean> = {
  'cancel-code': true,
  'cancel-code-ip': true,
};

// 004 撤销提交 (EP4, public phone-hash)
export const CANCEL_SUBMIT_BUCKETS: Record<string, boolean> = {
  'cancel-submit': true,
  'cancel-submit-ip': true,
};

/** 004 全部 4 组 deletion 桶 —— 既有 (001/002/003) 路由 spread 此跳过新桶。 */
export const ALL_DELETION_BUCKETS: Record<string, boolean> = {
  ...DEL_CODE_BUCKETS,
  ...DEL_SUBMIT_BUCKETS,
  ...CANCEL_CODE_BUCKETS,
  ...CANCEL_SUBMIT_BUCKETS,
};

// 005 设备列表 (US1, authed) — list EP per-account 30/60s · per-IP 100/60s
export const DEVICE_LIST_BUCKETS: Record<string, boolean> = {
  'dev-list-account': true,
  'dev-list-ip': true,
};

// 005 单设备撤销 (US2, authed) — revoke EP per-account 5/60s · per-IP 20/60s
export const DEVICE_REVOKE_BUCKETS: Record<string, boolean> = {
  'dev-revoke-account': true,
  'dev-revoke-ip': true,
};

/** 005 全部设备桶 —— 既有 (001-004) 路由 spread 此跳过新桶 (device EP 互相也 spread 对方组)。 */
export const DEVICE_BUCKETS: Record<string, boolean> = {
  ...DEVICE_LIST_BUCKETS,
  ...DEVICE_REVOKE_BUCKETS,
};

// 010 微信绑定 (EP1, authed) — bind EP per-account 5/60s · per-IP 10/60s
export const WECHAT_BIND_BUCKETS: Record<string, boolean> = {
  'wx-bind': true,
  'wx-bind-ip': true,
};

// 010 微信解绑发码 (EP2, authed) — per-account 1/60s · per-IP 5/60s
export const WECHAT_UNBIND_CODE_BUCKETS: Record<string, boolean> = {
  'wx-unbind-code': true,
  'wx-unbind-code-ip': true,
};

// 010 微信解绑提交 (EP3, authed) — per-account 5/60s · per-IP 10/60s
export const WECHAT_UNBIND_BUCKETS: Record<string, boolean> = {
  'wx-unbind': true,
  'wx-unbind-ip': true,
};

/** 010 全部微信桶 —— 既有 (001-005) 路由 spread 此跳过新桶 (wechat EP 互相也 spread 对方组)。 */
export const WECHAT_BUCKETS: Record<string, boolean> = {
  ...WECHAT_BIND_BUCKETS,
  ...WECHAT_UNBIND_CODE_BUCKETS,
  ...WECHAT_UNBIND_BUCKETS,
};

// 011 证券市场偏好 (EP1 GET 读, EP2 PUT 写) — 均 per-account (AccountIdThrottlerGuard)。
// get 60/60s · put 30/60s (plan D3)。
export const MARKET_PREF_BUCKETS: Record<string, boolean> = {
  'mkt-pref-get-account': true,
  'mkt-pref-put-account': true,
};

/** 011 全部证券市场偏好桶 —— 既有 (001-010) 路由 spread 此跳过新桶 (portfolio EP 也 spread 对方桶)。 */
export const MARKET_PREF_ALL: Record<string, boolean> = {
  ...MARKET_PREF_BUCKETS,
};

// 012 券商账户绑定 (EP1 GET list, EP2 POST bind, EP3 DELETE) — 均 per-account
// (AccountIdThrottlerGuard 先填 req.user.accountId)。get 60/60s · post 30/60s ·
// delete 30/60s (plan D4)。
export const BROKER_ACCT_BUCKETS: Record<string, boolean> = {
  'broker-acct-get-account': true,
  'broker-acct-post-account': true,
  'broker-acct-delete-account': true,
};

/** 012 全部券商账户桶 —— 既有 (001-011) 路由 spread 此跳过新桶 (broker EP 内部也 spread 同组其余桶)。 */
export const BROKER_ACCT_ALL: Record<string, boolean> = {
  ...BROKER_ACCT_BUCKETS,
};

// 015 marketdata 读端点 (EP1 搜索 / EP2 报价 / EP3 详情 / EP4 K线) — 均 per-account
// (AccountIdThrottlerGuard 先填 req.user.accountId)。search 60/quote 120/detail 60/bars 60
// (均 /60s, plan tasks gate)。4 桶各独立常量供 marketdata controller 逐 EP @Throttle 己桶 +
// @SkipThrottle 同组其余桶。search 桶端点落 PR3 (T014), 但本 T009 一并注册+反污染 (避免 T014
// 再扫一遍既有 controller)。
export const MKTDATA_SEARCH_BUCKET: Record<string, boolean> = { 'mktdata-search-account': true };
export const MKTDATA_QUOTE_BUCKET: Record<string, boolean> = { 'mktdata-quote-account': true };
export const MKTDATA_DETAIL_BUCKET: Record<string, boolean> = { 'mktdata-detail-account': true };
export const MKTDATA_BARS_BUCKET: Record<string, boolean> = { 'mktdata-bars-account': true };
// 072 冷启动结局读端点 —— 采纳后要在串行队列排空前轮询, 故限额比其它读桶宽一档。
export const MKTDATA_COLDSTART_BUCKET: Record<string, boolean> = {
  'mktdata-coldstart-account': true,
};

/** 015 全部 marketdata 桶 —— 既有 (001-012) 路由 spread 此跳过新桶 (marketdata EP 内部 spread 同组其余桶)。 */
export const MARKETDATA_ALL: Record<string, boolean> = {
  ...MKTDATA_SEARCH_BUCKET,
  ...MKTDATA_QUOTE_BUCKET,
  ...MKTDATA_DETAIL_BUCKET,
  ...MKTDATA_BARS_BUCKET,
  ...MKTDATA_COLDSTART_BUCKET,
};

// 013 自选列表分组 / 自选项 (EP1-EP9) — 均 per-account (AccountIdThrottlerGuard 先填
// req.user.accountId)。read 120/60s (GET groups/items) · write 60/60s (POST/PATCH/DELETE
// 建/改名/删/reorder/item ops) (plan D5)。2 桶各独立常量供 watchlist controller 逐 EP
// @Throttle 己桶 + @SkipThrottle 同组其余桶。items 端点 (EP6-EP9) 落 T009, 但本 T006 一并
// 注册+反污染 (避免 T009 再扫一遍既有 controller, 同 015 search 桶预注册)。
export const WATCHLIST_READ_BUCKET: Record<string, boolean> = { 'watchlist-read-account': true };
export const WATCHLIST_WRITE_BUCKET: Record<string, boolean> = { 'watchlist-write-account': true };

/** 013 全部 watchlist 桶 —— 既有 (001-012/015) 路由 spread 此跳过新桶 (watchlist EP 内部 spread 同组其余桶)。 */
export const WATCHLIST_ALL: Record<string, boolean> = {
  ...WATCHLIST_READ_BUCKET,
  ...WATCHLIST_WRITE_BUCKET,
};

// 021 alert 预警 CRUD + 消息中心 (EP1-EP8) — 均 per-account (AccountIdThrottlerGuard 先填
// req.user.accountId)。read 120/60s (EP1 个股列表/EP2 全部列表/EP6 消息/EP7 未读数) ·
// write 30/60s (EP3 批量建/EP4 编辑/EP5 批量删/EP8 置已读)。2 桶各独立常量供 alert 两
// controller 逐 EP @Throttle 己桶 + @SkipThrottle 同组其余桶。
export const ALERT_READ_BUCKET: Record<string, boolean> = { 'alert-read-account': true };
export const ALERT_WRITE_BUCKET: Record<string, boolean> = { 'alert-write-account': true };

/** 021 全部 alert 桶 —— 既有 (001-015) 路由 spread 此跳过新桶 (alert EP 内部 spread 同组其余桶)。 */
export const ALERT_ALL: Record<string, boolean> = {
  ...ALERT_READ_BUCKET,
  ...ALERT_WRITE_BUCKET,
};

// 025 持仓导入 (EP1 POST holdings/import) — per-account 6/60s; 持仓读 (EP2 GET holdings /
// EP3 GET trades 共用) — per-account 120/60s (对齐 alert/watchlist read 体例,
// AccountIdThrottlerGuard 先填 req.user.accountId)。
export const PORTFOLIO_IMPORT_BUCKET: Record<string, boolean> = {
  'portfolio-import-account': true,
};
export const PORTFOLIO_HOLDINGS_READ_BUCKET: Record<string, boolean> = {
  'portfolio-holdings-read-account': true,
};

/** 025 全部持仓桶 —— 既有 (001-021) 路由 spread 此跳过新桶 (025 EP 内部 spread 同组其余桶)。 */
export const PORTFOLIO_HOLDINGS_ALL: Record<string, boolean> = {
  ...PORTFOLIO_IMPORT_BUCKET,
  ...PORTFOLIO_HOLDINGS_READ_BUCKET,
};

// 027 chat AI 对话 (T006 建会话/取消息 + T007 SSE 发消息) — 均 per-account
// (AccountIdThrottlerGuard 先填 req.user.accountId)。read 120/60s (取消息) ·
// write 30/60s (建会话; 发消息走流式但仍计写桶, T007 接)。2 桶各独立常量供 chat
// controller 逐 EP @Throttle 己桶 + @SkipThrottle 同组其余桶。T007 SSE 端点复用
// CHAT_WRITE_BUCKET, 故 T006 一并注册避免 T007 再扫既有 controller。
export const CHAT_READ_BUCKET: Record<string, boolean> = { 'chat-read-account': true };
export const CHAT_WRITE_BUCKET: Record<string, boolean> = { 'chat-write-account': true };

/** 027 全部 chat 桶 —— 既有 (001-025) 路由 spread 此跳过新桶 (chat EP 内部 spread 同组其余桶)。 */
export const CHAT_ALL: Record<string, boolean> = {
  ...CHAT_READ_BUCKET,
  ...CHAT_WRITE_BUCKET,
};

// 032 ideation 灵感会话 (T007 CRUD/生命周期 + T008/T009 SSE 澄清/产出) — 均 per-account。
// read 120/60s (列/查) · write 30/60s (建/删/重开)。2 桶各独立常量供 ideation controller
// 逐 EP @Throttle 己桶 + @SkipThrottle 同组其余桶 (沿 chat / 021 范式)。
export const IDEATION_READ_BUCKET: Record<string, boolean> = { 'ideation-read-account': true };
export const IDEATION_WRITE_BUCKET: Record<string, boolean> = { 'ideation-write-account': true };

/** 032 全部 ideation 桶。 */
export const IDEATION_ALL: Record<string, boolean> = {
  ...IDEATION_READ_BUCKET,
  ...IDEATION_WRITE_BUCKET,
};

// 045 optionsdesk 锚管理 + 击球区雷达 (T010 锚 CRUD/复审/PIT + T013 雷达) — 均 per-account
// (AccountIdThrottlerGuard 先填 req.user.accountId)。read 120/60s (列表/详情/PIT/雷达) ·
// write 30/60s (建/改/删/复审)。2 桶各独立常量供 optionsdesk controller 逐 EP @Throttle 己桶 +
// @SkipThrottle 同组其余桶 (沿 alert / chat / ideation 范式)。雷达端点 (T013) 复用 read 桶,
// 故 T010 一并注册避免 T013 再扫一遍既有 controller (同 015 search 桶预注册体例)。
export const OPTIONSDESK_READ_BUCKET: Record<string, boolean> = {
  'optionsdesk-read-account': true,
};
export const OPTIONSDESK_WRITE_BUCKET: Record<string, boolean> = {
  'optionsdesk-write-account': true,
};

/**
 * 072 采纳桶 —— **6 次/分, 蓄意远严于 write 桶的 30**。
 *
 * 它不是「防滥用」而是**节流**: 每次 `action=create` 的采纳会排一个冷启动 job, 而那是
 * 分钟级、`concurrency=1` 的真 vendor 外呼。用 write 桶的 30/分, 手快的人一分钟能排进 30 个
 * 冷启动、把队列堵到几小时后。
 *
 * 📌 这个数字直接继承 `ops/bin/anchor-approve.sh` 的 `PACE_SECONDS=11`
 * (「直写口 6 次/分的漏桶 ⇒ 每 10 秒补一格」) —— **本桶就是那个 shell 常量的线上替身**,
 * 把约束从脚本挪进系统。改它前先想清楚下游那条串行队列。
 */
export const OPTIONSDESK_APPROVE_BUCKET: Record<string, boolean> = {
  'optionsdesk-approve-account': true,
};

/** 045 全部 optionsdesk 桶 —— 既有 (001-032) 路由 spread 此跳过新桶。 */
export const OPTIONSDESK_ALL: Record<string, boolean> = {
  ...OPTIONSDESK_READ_BUCKET,
  ...OPTIONSDESK_WRITE_BUCKET,
  // 折进组常量 ⇒ 既有路由靠 skipExcept(OPTIONSDESK_ALL) 自动跳过新桶, 其它 controller 零改动。
  ...OPTIONSDESK_APPROVE_BUCKET,
};
