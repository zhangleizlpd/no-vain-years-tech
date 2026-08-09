-- CreateTable
CREATE TABLE "ideation"."idea_attachment" (
    "id" BIGSERIAL NOT NULL,
    "session_id" BIGINT NOT NULL,
    "account_id" BIGINT NOT NULL,
    "oss_key" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'image',
    "annotations_json" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idea_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ix_idea_attachment_session_id" ON "ideation"."idea_attachment"("session_id", "id");
