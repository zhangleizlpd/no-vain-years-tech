-- Phone SMS Auth US2 outbox table (FR-S11).
-- Decision: keep Spring Modulith legacy `event_publication` untouched; use a
-- dedicated, simplified `outbox_event` table for new domain events.

CREATE TABLE "outbox_event" (
    "id"           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    "event_type"   TEXT         NOT NULL,
    "payload"      JSONB        NOT NULL,
    "published_at" TIMESTAMPTZ(6),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW()
);

CREATE INDEX "outbox_event_unpublished_idx"
    ON "outbox_event" ("created_at");

