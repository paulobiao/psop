CREATE TABLE "user_sessions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "refresh_token_hash" TEXT NOT NULL,
    "ip_address" TEXT,
    "user_agent" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "last_used_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_sessions_organization_id_created_at_idx"
ON "user_sessions"("organization_id", "created_at");

CREATE INDEX "user_sessions_user_id_revoked_at_idx"
ON "user_sessions"("user_id", "revoked_at");

CREATE INDEX "user_sessions_expires_at_idx"
ON "user_sessions"("expires_at");

ALTER TABLE "user_sessions"
ADD CONSTRAINT "user_sessions_organization_id_fkey"
FOREIGN KEY ("organization_id")
REFERENCES "organizations"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "user_sessions"
ADD CONSTRAINT "user_sessions_user_id_fkey"
FOREIGN KEY ("user_id")
REFERENCES "users"("id")
ON DELETE CASCADE
ON UPDATE CASCADE;
