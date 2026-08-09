-- 019 T011 hard 边 corp→eod + 派生序变更 (PR-3, D8 时序: 拓扑派生 (PR-2) 落地后才可加 —
-- 旧常量序 eod 在 corp 前, 提前加 = 倒流边 assembler throw 整夜瘫痪):
--   ① 插 hard 边 corporate_action → eod_bar (除权日因子先写、eod 重算后行, FR-S08;
--      仅两者同 won 时生效 — corp 未 won 不阻塞 eod, assembler 既有语义);
--   ② priority 调整 corporate_action 6 / eod_bar 5 (financial 7 不动, analyze H1:
--      corp 7/fin 6 会派生 […,corp,financial,eod] 使 hard 边非相邻 throw)。
-- 派生序 → [universe, profile, fundamental, financial, corporate_action, eod_bar],
-- 两条 hard 边 (profile→fundamental / corp→eod) 均链相邻。幂等 (ON CONFLICT / UPDATE)。
-- migration_refs: specs/019-marketdata-sync-strategy (US3 hard 边; FR-S08)。

INSERT INTO "marketdata"."sync_dependency" ("upstream", "downstream", "mode")
VALUES ('corporate_action', 'eod_bar', 'hard')
ON CONFLICT ("upstream", "downstream") DO NOTHING;

UPDATE "marketdata"."sync_dimension" SET "priority" = 6 WHERE "dimension_key" = 'corporate_action';
UPDATE "marketdata"."sync_dimension" SET "priority" = 5 WHERE "dimension_key" = 'eod_bar';
