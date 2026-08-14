/**
 * `@db.Date` 列 ↔ `YYYY-MM-DD` 的两向换算 —— optionsdesk 内**日期键的单一口径**。
 *
 * 📌 出身: 原住 `monthly-expiry-lookup.ts`。那个文件在 #45 随月度链标换源 (交易日历 → vendor
 * 到期周期) 整体删除, 而这两个 helper 的消费方与月度标无关 (财报日查询 / 到期日分组键 /
 * 月度标集合的键) ⇒ 抽出来单放, 不跟着连坐删。
 *
 * 🚨 **一律走 UTC** —— `@db.Date` 读出来就是 UTC 午夜, 用本地时区取日期会让宿主在 UTC−N 的
 * 机器上把整片日期算成前一天, 而**测试在 UTC+8 的开发机上照样绿**。
 */

/** `@db.Date` 的 UTC 午夜 Date → `YYYY-MM-DD`。 */
export function dateOnlyOf(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** `YYYY-MM-DD` → `@db.Date` 比较用的 UTC 午夜 Date。 */
export function utcMidnight(dateOnly: string): Date {
  return new Date(`${dateOnly}T00:00:00.000Z`);
}
