-- 047 optionsdesk M2b: optionsdesk.anchor 加**仓位水位手选值两列** (FR-017 / plan D-UI-5)。
-- expand-only 加两个 nullable 列, 零破坏性变更 → 单 PR 合规 (ADR-0035 + migration-rules §2)。
--
-- 仓位水位档在本片**无数据面** (持仓规模属 M3/M4) ⇒ 详情页给一个三选一手选控件补齐意图判定
--   矩阵的水位输入, 值按标的持久化。
--
-- **为什么落锚表两列而不是独立表** (plan D-UI-5): 它是**锚的一个属性** (按标的唯一), 不是
--   独立生命周期实体 —— 建独立表要配一整套 CRUD 面, 不摊销 (Senior Engineer Test)。
--
-- 🚫 **两列都 MUST NOT 给 DEFAULT** —— 默认任何一档 = FR-017 明禁的「替人做方向性假设」,
--   与 046 对水位档立下的「禁显 0、显未知」处置直接相悖。
--   ⇒ `NULL` = **未选**, 且这是**常驻分支不是过渡态** (spec Edge Cases 明写): 新建锚的票天然
--   处于未选, 必须能正常读表 —— 未选时 Tab 停「全腿」+ 显式提示「选一次水位档以定位意图」。
--   ⚠️ 也因此**不能**照 migration-rules §4 那条「nullable 新列用 sentinel 默认值」—— 那条约束
--   的前提是「该列要进唯一约束」, 本列不进任何约束, 且 sentinel 在这里正好等于替人假设一档。
--
-- 列名带 `_manual` 后缀是**数据来源的结构性表达** (plan D-UI-5: 人工输入语义 MUST 显式表达,
--   不是靠前端记得): M3 接真实持仓水位时新来源另落列, 靠列名即可分辨哪些是人填的。
--   ⚠️ 与锚表既有「人工位三列」(v_manual / l_level_manual / position_cap_manual) **语义不同**:
--   那三列是上游刷新即回落的**临时覆写**; 本列没有上游可回落, 是降级路径下的**唯一值**, 直到
--   M3 用真实水位取代 (与 v1「现金手工录入」同形态, p1 §5 P3 先例)。
--
-- 值域 (贫血字符串, 无枚举表, 同 l_level_manual 体例): 'lt_one_third' (<1/3) ·
--   'one_to_two_thirds' (1/3–2/3) · 'gte_two_thirds' (≥2/3)。判定归 optionsdesk 的 rules 单点。
--
-- migration_refs: specs/047-optionsdesk-chain-leg-picker (FR-017 水位手选 chip)

-- AlterTable
ALTER TABLE "optionsdesk"."anchor" ADD COLUMN     "position_bucket_manual" VARCHAR(24),
ADD COLUMN     "position_bucket_set_at" TIMESTAMPTZ(6);
