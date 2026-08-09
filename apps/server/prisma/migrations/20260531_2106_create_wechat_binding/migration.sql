-- CreateTable
CREATE TABLE "account"."wechat_binding" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "provider" VARCHAR(16) NOT NULL DEFAULT 'WECHAT',
    "openid" VARCHAR(64) NOT NULL,
    "unionid" VARCHAR(64),
    "bound_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wechat_binding_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_wechat_binding_openid" ON "account"."wechat_binding"("openid");

-- CreateIndex
CREATE UNIQUE INDEX "uk_wechat_binding_account_provider" ON "account"."wechat_binding"("account_id", "provider");
