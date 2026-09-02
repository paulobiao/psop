-- Operational Health Engine V2
-- Adds collection-quality and capability evidence to the direct telemetry
-- snapshot. All columns are additive and nullable; no data migration needed.

-- AlterTable
ALTER TABLE "device_telemetry_snapshots" ADD COLUMN     "collection_state" TEXT;
ALTER TABLE "device_telemetry_snapshots" ADD COLUMN     "collection_issues" JSONB;
ALTER TABLE "device_telemetry_snapshots" ADD COLUMN     "capabilities" JSONB;
