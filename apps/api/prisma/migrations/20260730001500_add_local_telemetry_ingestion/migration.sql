CREATE TABLE "device_ingestion_credentials" (
  "device_id" UUID NOT NULL,
  "key_hash" TEXT NOT NULL,
  "key_prefix" TEXT NOT NULL,
  "rotated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "device_ingestion_credentials_pkey" PRIMARY KEY ("device_id")
);

CREATE TABLE "device_telemetry_snapshots" (
  "device_id" UUID NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reported_status" TEXT,
  "temperature_c" DOUBLE PRECISION,
  "bitrate_kbps" INTEGER,
  "storage_used_pct" DOUBLE PRECISION,
  "uptime_seconds" INTEGER,
  "model" TEXT,
  "firmware" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "device_telemetry_snapshots_pkey" PRIMARY KEY ("device_id")
);

CREATE TABLE "device_connectivity_events" (
  "id" UUID NOT NULL,
  "device_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "previous_state" TEXT,
  "current_state" TEXT NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_heartbeat_at" TIMESTAMP(3),
  "age_seconds" INTEGER,
  "expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "device_connectivity_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "device_telemetry_snapshots_observed_at_idx"
  ON "device_telemetry_snapshots"("observed_at");

CREATE INDEX "device_connectivity_events_device_id_detected_at_idx"
  ON "device_connectivity_events"("device_id", "detected_at");

CREATE INDEX "device_connectivity_events_detected_at_idx"
  ON "device_connectivity_events"("detected_at");

ALTER TABLE "device_ingestion_credentials"
  ADD CONSTRAINT "device_ingestion_credentials_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "device_telemetry_snapshots"
  ADD CONSTRAINT "device_telemetry_snapshots_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "device_connectivity_events"
  ADD CONSTRAINT "device_connectivity_events_device_id_fkey"
  FOREIGN KEY ("device_id") REFERENCES "devices"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
