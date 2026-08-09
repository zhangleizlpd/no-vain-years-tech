-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "account";

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "account"."account" (
    "id" BIGSERIAL NOT NULL,
    "phone" VARCHAR(20),
    "status" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),
    "display_name" VARCHAR(64),
    "freeze_until" TIMESTAMPTZ(6),
    "previous_phone_hash" VARCHAR(64),

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."account_sms_code" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "purpose" VARCHAR(32) NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_sms_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."credential" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "type" VARCHAR(16) NOT NULL,
    "password_hash" VARCHAR(60),
    "last_used_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."realname_profile" (
    "id" BIGSERIAL NOT NULL,
    "account_id" BIGINT NOT NULL,
    "status" VARCHAR(16) NOT NULL,
    "real_name_enc" BYTEA,
    "id_card_no_enc" BYTEA,
    "id_card_hash" VARCHAR(64),
    "provider_biz_id" VARCHAR(64),
    "verified_at" TIMESTAMPTZ(6),
    "failed_reason" VARCHAR(32),
    "failed_at" TIMESTAMPTZ(6),
    "retry_count_24h" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "realname_profile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account"."refresh_token" (
    "id" BIGSERIAL NOT NULL,
    "token_hash" VARCHAR(64) NOT NULL,
    "account_id" BIGINT NOT NULL,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "device_id" VARCHAR(36) NOT NULL,
    "device_name" VARCHAR(64),
    "device_type" VARCHAR(16) NOT NULL DEFAULT 'UNKNOWN',
    "ip_address" VARCHAR(45),
    "login_method" VARCHAR(16) NOT NULL DEFAULT 'PHONE_SMS',

    CONSTRAINT "refresh_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "event_publication" (
    "id" UUID NOT NULL,
    "listener_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "serialized_event" TEXT NOT NULL,
    "publication_date" TIMESTAMPTZ(6) NOT NULL,
    "completion_date" TIMESTAMPTZ(6),

    CONSTRAINT "event_publication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "flyway_schema_history" (
    "installed_rank" INTEGER NOT NULL,
    "version" VARCHAR(50),
    "description" VARCHAR(200) NOT NULL,
    "type" VARCHAR(20) NOT NULL,
    "script" VARCHAR(1000) NOT NULL,
    "checksum" INTEGER,
    "installed_by" VARCHAR(100) NOT NULL,
    "installed_on" TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "execution_time" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,

    CONSTRAINT "flyway_schema_history_pk" PRIMARY KEY ("installed_rank")
);

-- CreateIndex
CREATE UNIQUE INDEX "uk_account_phone" ON "account"."account"("phone");

-- CreateIndex
CREATE INDEX "idx_account_freeze_until_active" ON "account"."account"("freeze_until") WHERE (((status)::text = 'FROZEN'::text) AND (freeze_until IS NOT NULL));

-- CreateIndex
CREATE INDEX "idx_account_previous_phone_hash" ON "account"."account"("previous_phone_hash") WHERE (previous_phone_hash IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_account_sms_code_account_purpose_active" ON "account"."account_sms_code"("account_id", "purpose") WHERE (used_at IS NULL);

-- CreateIndex
CREATE INDEX "idx_credential_account_id" ON "account"."credential"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_credential_account_type" ON "account"."credential"("account_id", "type");

-- CreateIndex
CREATE UNIQUE INDEX "realname_profile_account_id_key" ON "account"."realname_profile"("account_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_realname_profile_id_card_hash" ON "account"."realname_profile"("id_card_hash") WHERE (id_card_hash IS NOT NULL);

-- CreateIndex
CREATE INDEX "idx_realname_profile_provider_biz_id" ON "account"."realname_profile"("provider_biz_id");

-- CreateIndex
CREATE UNIQUE INDEX "uk_refresh_token_token_hash" ON "account"."refresh_token"("token_hash");

-- CreateIndex
CREATE INDEX "idx_refresh_token_account_device_active" ON "account"."refresh_token"("account_id", "device_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE INDEX "idx_refresh_token_account_id_active" ON "account"."refresh_token"("account_id") WHERE (revoked_at IS NULL);

-- CreateIndex
CREATE INDEX "event_publication_by_completion_date_idx" ON "event_publication"("completion_date");

-- CreateIndex
CREATE INDEX "event_publication_serialized_event_hash_idx" ON "event_publication" USING HASH ("serialized_event");

-- CreateIndex
CREATE INDEX "flyway_schema_history_s_idx" ON "flyway_schema_history"("success");

-- AddForeignKey
ALTER TABLE "account"."credential" ADD CONSTRAINT "credential_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "account"."account"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
