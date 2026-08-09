-- 复权因子加来源 + 质量态两列，配合算法从「vendor 已复权序列反推」换成「事件条款计算」。
--
-- 背景 (2026-08-01 直连理杏仁 API PoC 实证): 旧口径 `anchorFactorJumps` 从 vendor backward
-- 序列反推 `f = (b1/b0)·(n0/n1)`，隐含假设 vendor 用**乘法**复权。实测 `bc_rights` 在两个
-- 公司行动之间是**仿射**变换 `bc = K·ex − C`（00206 拟合 K=2 / C=0.43，93 个交易日残差 0），
-- 仿射映射不保比值 ⇒ 反推口径不成立。prod 62 行 ≥10% 分歧因子全部来自该口径。
--
-- 新口径 = 业内标准除权价公式（CRSP FACPR/CFACPR、Tushare adj_factor、通达信同源）+
-- 涨跌幅复权法（BaoStock 同源）作独立见证的 2-of-2 闸。
--
-- 列语义:
--   source = event_terms | official_change | unresolved | legacy_vendor_anchor
--   status = verified | unverified | needs_review
--
-- 🚨 存量行按 `legacy_vendor_anchor` / `unverified` 回填，**不是** needs_review:
-- 它们确实未经交叉校验（诚实），但把 29,847 行一次性刷成待审会让质量闸从上线第一天就淹没，
-- 闸一旦不可信就等于没有。存量的真实质量由后续全量重算逐行判定并改写这两列。
--
-- 纯 additive: 2 个 NOT NULL + DEFAULT 列，无删列/改列/改约束 ⇒ 不触发
-- expand-migrate-contract 三步法。旧代码不写这两列时由 DEFAULT 兜底，滚动部署安全。

ALTER TABLE "marketdata"."adjustment_factor"
  ADD COLUMN "source" VARCHAR(24) NOT NULL DEFAULT 'legacy_vendor_anchor',
  ADD COLUMN "status" VARCHAR(16) NOT NULL DEFAULT 'unverified';
