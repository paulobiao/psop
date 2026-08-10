CREATE TYPE "NotificationChannel" AS ENUM (
  'EMAIL'
);

CREATE TYPE "NotificationEventType" AS ENUM (
  'INCIDENT_OPENED',
  'INCIDENT_RECOVERED'
);

CREATE TYPE "NotificationDeliveryStatus" AS ENUM (
  'PENDING',
  'SENT',
  'FAILED',
  'SKIPPED_NOT_CONFIGURED',
  'SKIPPED_COOLDOWN',
  'SKIPPED_POLICY'
);

CREATE TABLE "notification_policies" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "minimum_severity" "AlertSeverity" NOT NULL DEFAULT 'CRITICAL',
  "notify_on_recovery" BOOLEAN NOT NULL DEFAULT true,
  "notify_admins" BOOLEAN NOT NULL DEFAULT true,
  "notify_operators" BOOLEAN NOT NULL DEFAULT true,
  "explicit_emails" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "cooldown_minutes" INTEGER NOT NULL DEFAULT 0,
  "escalation_delay_minutes" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_policies_pkey"
    PRIMARY KEY ("id")
);

CREATE TABLE "notification_deliveries" (
  "id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "alert_id" UUID NOT NULL,
  "event_type" "NotificationEventType" NOT NULL,
  "channel" "NotificationChannel" NOT NULL DEFAULT 'EMAIL',
  "recipient_email" TEXT NOT NULL,
  "recipient_source" TEXT NOT NULL,
  "status" "NotificationDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "dedup_key" TEXT NOT NULL,
  "subject" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "eligible_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "last_attempt_at" TIMESTAMP(3),
  "next_attempt_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "notification_deliveries_pkey"
    PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "notification_policies_organization_id_key"
  ON "notification_policies"("organization_id");

CREATE UNIQUE INDEX "notification_deliveries_dedup_key_key"
  ON "notification_deliveries"("dedup_key");

CREATE INDEX "notification_deliveries_organization_id_created_at_idx"
  ON "notification_deliveries"("organization_id", "created_at");

CREATE INDEX "notification_deliveries_organization_id_status_eligible_at_idx"
  ON "notification_deliveries"("organization_id", "status", "eligible_at");

CREATE INDEX "notification_deliveries_alert_id_event_type_idx"
  ON "notification_deliveries"("alert_id", "event_type");

CREATE INDEX "notification_deliveries_recipient_email_sent_at_idx"
  ON "notification_deliveries"("recipient_email", "sent_at");

ALTER TABLE "notification_policies"
  ADD CONSTRAINT "notification_policies_organization_id_fkey"
  FOREIGN KEY ("organization_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_organization_id_fkey"
  FOREIGN KEY ("organization_id")
  REFERENCES "organizations"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;

ALTER TABLE "notification_deliveries"
  ADD CONSTRAINT "notification_deliveries_alert_id_fkey"
  FOREIGN KEY ("alert_id")
  REFERENCES "alerts"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
