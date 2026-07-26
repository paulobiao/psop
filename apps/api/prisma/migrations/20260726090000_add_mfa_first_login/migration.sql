ALTER TABLE "users"
ADD COLUMN "must_change_password" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "mfa_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "mfa_secret_encrypted" TEXT,
ADD COLUMN "mfa_recovery_code_hashes" JSONB,
ADD COLUMN "mfa_enabled_at" TIMESTAMP(3);

CREATE TABLE "auth_challenges" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "auth_challenges_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "auth_challenges_user_id_type_used_at_expires_at_idx"
ON "auth_challenges"(
    "user_id",
    "type",
    "used_at",
    "expires_at"
);

CREATE INDEX "auth_challenges_organization_id_created_at_idx"
ON "auth_challenges"(
    "organization_id",
    "created_at"
);

ALTER TABLE "auth_challenges"
ADD CONSTRAINT "auth_challenges_organization_id_fkey"
FOREIGN KEY ("organization_id")
REFERENCES "organizations"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "auth_challenges"
ADD CONSTRAINT "auth_challenges_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
