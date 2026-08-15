-- CreateTable
CREATE TABLE "recorder_observation_snapshots" (
    "device_id" UUID NOT NULL,
    "recorder_device_id" UUID NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reported_status" TEXT NOT NULL,
    "channel_id" TEXT,
    "channel_number" INTEGER,
    "poe_port" INTEGER,
    "poe_power_w" DOUBLE PRECISION,
    "recording_status" TEXT,
    "protocol" TEXT,
    "bitrate_kbps" INTEGER,
    "resolution" TEXT,
    "frame_rate" INTEGER,
    "model" TEXT,
    "firmware" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "recorder_observation_snapshots_pkey" PRIMARY KEY ("device_id")
);

-- CreateIndex
CREATE INDEX "recorder_observation_snapshots_recorder_device_id_idx"
ON "recorder_observation_snapshots"("recorder_device_id");

-- CreateIndex
CREATE INDEX "recorder_observation_snapshots_observed_at_idx"
ON "recorder_observation_snapshots"("observed_at");

-- AddForeignKey
ALTER TABLE "recorder_observation_snapshots"
ADD CONSTRAINT "recorder_observation_snapshots_device_id_fkey"
FOREIGN KEY ("device_id") REFERENCES "devices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recorder_observation_snapshots"
ADD CONSTRAINT "recorder_observation_snapshots_recorder_device_id_fkey"
FOREIGN KEY ("recorder_device_id") REFERENCES "devices"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
