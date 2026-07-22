-- CreateEnum
CREATE TYPE "DeviceType" AS ENUM ('CAMERA', 'RECORDER', 'GATEWAY', 'ACCESS_CONTROLLER', 'SENSOR', 'INTERCOM', 'NETWORK_SWITCH');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'MAINTENANCE', 'DECOMMISSIONED');

-- CreateTable
CREATE TABLE "devices" (
    "id" UUID NOT NULL,
    "site_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "device_type" "DeviceType" NOT NULL,
    "manufacturer" TEXT,
    "model" TEXT,
    "firmware_version" TEXT,
    "ip_address" TEXT,
    "serial_number" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'ACTIVE',
    "expected_heartbeat_interval" INTEGER NOT NULL DEFAULT 60,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "devices_site_id_idx" ON "devices"("site_id");

-- CreateIndex
CREATE INDEX "devices_device_type_idx" ON "devices"("device_type");

-- CreateIndex
CREATE UNIQUE INDEX "devices_site_id_external_id_key" ON "devices"("site_id", "external_id");

-- AddForeignKey
ALTER TABLE "devices" ADD CONSTRAINT "devices_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
