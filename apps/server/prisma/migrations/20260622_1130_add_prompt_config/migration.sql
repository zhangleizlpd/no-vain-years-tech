-- CreateTable
CREATE TABLE "ideation"."prompt_config" (
    "key" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "description" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "prompt_config_pkey" PRIMARY KEY ("key")
);
