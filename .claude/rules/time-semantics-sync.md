---
paths:
  - 'apps/server/src/marketdata/**'
  - 'apps/server/src/optionsdesk/**'
---

# 时间语义（path-triggered，改 marketdata / optionsdesk 自动加载）

写任何「今天 / 交易日 / 哪一场收了 / 剩余期限 / 陈旧」代码前，先查 canonical 的 §0 速查表对号入座 —— **不要重新发明**。invariant：

- 存 UTC instant，日期是派生量；业务日期列必须写明是**谁的**日期。
- 「今天」只有三个合法答案：交易所 / 用户所在地 / UTC 绝对时刻（不取日期）。UTC 日期不是任何人的今天；宿主日不是业务日。
- 收盘口径数据走 `sessionWatermark` 族 + 日历 `kind` 三态，别拿日历日采（盘中落半根）；快照归属统一 `resolveSnapshotAttribution`，别在调用点重算；判据必须与执行时刻解耦。
- DTE = 整数日历日、到期日 = 0、起点交易所今天（`daysToExpiry`）；365 与 252 两套分母不混。
- 机器只拦 Rule A / B / C（`scripts/checks/check-time-semantics.ts`）；差一天**不报错** → 写测试钉住基准。

canonical：[`docs/conventions/cross-timezone-date-semantics.md`](../../docs/conventions/cross-timezone-date-semantics.md)（§0 速查表 + §6 七问自检）；决策在 ADR-0066。
