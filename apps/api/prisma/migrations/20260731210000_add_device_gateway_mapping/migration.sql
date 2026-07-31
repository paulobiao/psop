CREATE TYPE "DeviceMonitoringMode" AS ENUM (
  'DIRECT',
  'VIA_GATEWAY',
  'INVENTORY_ONLY'
);

ALTER TABLE "devices"
ADD COLUMN "monitoring_mode" "DeviceMonitoringMode" NOT NULL DEFAULT 'DIRECT',
ADD COLUMN "gateway_device_id" UUID;

CREATE INDEX "devices_monitoring_mode_idx"
ON "devices"("monitoring_mode");

CREATE INDEX "devices_gateway_device_id_idx"
ON "devices"("gateway_device_id");

ALTER TABLE "devices"
ADD CONSTRAINT "devices_gateway_device_id_fkey"
FOREIGN KEY ("gateway_device_id")
REFERENCES "devices"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;
