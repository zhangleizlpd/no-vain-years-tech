-- AlterTable (036 T018, expand 纯增列): IdeaAttachment 关联具体 user turn (nullable)。
ALTER TABLE "ideation"."idea_attachment" ADD COLUMN "turn_id" BIGINT;

-- CreateIndex: 按 turn_id 投影 per-turn 附件 (FR-009 读侧补全)。
CREATE INDEX "ix_idea_attachment_turn_id" ON "ideation"."idea_attachment"("turn_id");
