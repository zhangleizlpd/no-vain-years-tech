-- Plan 2 Phase 0 § 2.2.1: drop non-business tables introduced by W1.4 `prisma db pull`
-- against legacy meta-repo (Spring Modulith + Java/Flyway) state.
--
-- - `event_publication`: Spring Modulith event store; superseded by mono `outbox_event`
--   (per migration `1_add_outbox_event` + 2026-05-17 W2.4 US2 decision).
-- - `flyway_schema_history`: Java Flyway migration history; Prisma owns mono migrations now.
--
-- One-time destructive cleanup; user-authorized per Plan 2 § 2.2.1.
-- `outbox_event` explicitly preserved.

DROP TABLE IF EXISTS "public"."event_publication" CASCADE;
DROP TABLE IF EXISTS "public"."flyway_schema_history" CASCADE;
