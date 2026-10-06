CREATE TYPE "EvidenceKind" AS ENUM ('OBSERVATION', 'ASSERTION');
CREATE TYPE "EvidenceSource" AS ENUM ('DEVICE', 'RECORDER', 'ADAPTER', 'GATEWAY', 'INVENTORY', 'API');
CREATE TYPE "EvidenceConfidence" AS ENUM ('DECLARED', 'OBSERVED', 'VERIFIED');
CREATE TYPE "EvidenceLevel" AS ENUM (
  'E0_UNKNOWN',
  'E1_ENDPOINT_REACHABLE',
  'E2_IDENTITY_OBSERVED',
  'E3_PROFILE_DISCOVERED',
  'E4_STREAM_URI_OBTAINED',
  'E5_SESSION_NEGOTIATED',
  'E6_MEDIA_RECEIVED',
  'E7_RECORDING_PROVEN',
  'E8_RETRIEVAL_PROVEN'
);

CREATE TABLE "evidence_records" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "observer_device_id" UUID,
  "kind" "EvidenceKind" NOT NULL,
  "source" "EvidenceSource" NOT NULL,
  "confidence" "EvidenceConfidence" NOT NULL,
  "level" "EvidenceLevel" NOT NULL,
  "subject" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMP(3),
  "source_event_key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "evidence_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "evidence_records_source_event_key_key" ON "evidence_records"("source_event_key");
CREATE INDEX "evidence_records_device_id_observed_at_idx" ON "evidence_records"("device_id", "observed_at" DESC);
CREATE INDEX "evidence_records_observer_device_id_observed_at_idx" ON "evidence_records"("observer_device_id", "observed_at" DESC);
CREATE INDEX "evidence_records_level_observed_at_idx" ON "evidence_records"("level", "observed_at" DESC);

ALTER TABLE "evidence_records"
  ADD CONSTRAINT "evidence_records_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "evidence_records"
  ADD CONSTRAINT "evidence_records_observer_device_id_fkey"
  FOREIGN KEY ("observer_device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
