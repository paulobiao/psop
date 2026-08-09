CREATE TYPE "EdgeAgentDeliveryState" AS ENUM (
  'DELIVERED',
  'BUFFERED',
  'ERROR'
);

CREATE TABLE "edge_agent_runtime_snapshots" (
  "device_id" UUID NOT NULL,
  "agent_version" TEXT NOT NULL,
  "runtime_started_at" TIMESTAMP(3) NOT NULL,
  "uptime_seconds" INTEGER NOT NULL,
  "delivery_state" "EdgeAgentDeliveryState" NOT NULL DEFAULT 'DELIVERED',
  "previous_delivery_state" "EdgeAgentDeliveryState",
  "pending_buffer_count" INTEGER NOT NULL DEFAULT 0,
  "last_successful_delivery_at" TIMESTAMP(3),
  "last_delivery_error" TEXT,
  "last_delivery_error_at" TIMESTAMP(3),
  "reported_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "edge_agent_runtime_snapshots_pkey"
    PRIMARY KEY ("device_id")
);

CREATE INDEX "edge_agent_runtime_snapshots_reported_at_idx"
  ON "edge_agent_runtime_snapshots"("reported_at");

CREATE INDEX "edge_agent_runtime_snapshots_delivery_state_idx"
  ON "edge_agent_runtime_snapshots"("delivery_state");

ALTER TABLE "edge_agent_runtime_snapshots"
  ADD CONSTRAINT "edge_agent_runtime_snapshots_device_id_fkey"
  FOREIGN KEY ("device_id")
  REFERENCES "devices"("id")
  ON DELETE CASCADE
  ON UPDATE CASCADE;
