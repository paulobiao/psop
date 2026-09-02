-- AlterTable
ALTER TABLE "alerts" ADD COLUMN     "context" JSONB;

-- AlterTable
ALTER TABLE "device_connectivity_events" ADD COLUMN     "context" JSONB;
