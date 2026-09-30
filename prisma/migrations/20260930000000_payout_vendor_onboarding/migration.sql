-- M8 Easy Split vendor onboarding: extend PayoutAccount (no new table, no bank/UPI/KYC data stored).
ALTER TYPE "PayoutOnboardingStatus" ADD VALUE 'SUBMITTED';
ALTER TYPE "PayoutOnboardingStatus" ADD VALUE 'ON_HOLD';
ALTER TYPE "PayoutOnboardingStatus" ADD VALUE 'BLOCKED';

CREATE TYPE "PayoutMethod" AS ENUM ('BANK', 'UPI');

ALTER TABLE "PayoutAccount"
  ADD COLUMN "providerStatus" TEXT,
  ADD COLUMN "payoutMethod" "PayoutMethod",
  ADD COLUMN "settlementScheduleOption" INTEGER,
  ADD COLUMN "vendorIdempotencyKey" TEXT;
