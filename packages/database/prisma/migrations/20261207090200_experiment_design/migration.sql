-- AlterTable
ALTER TABLE "Experiment" ADD COLUMN     "biasFlags" JSONB,
ADD COLUMN     "conditions" JSONB,
ADD COLUMN     "design" TEXT NOT NULL DEFAULT 'LEGACY';

