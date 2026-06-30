-- Add merchant subscription pattern toggles to ShopOnboarding.
-- Exact output of `prisma migrate diff` against the canonical PostgreSQL schema
-- (drift-free). Column order is alphabetical per Prisma; Postgres matches by name.

-- AlterTable
ALTER TABLE "ShopOnboarding" ADD COLUMN     "allowAlternateDay" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowNthDay" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "allowWeekly" BOOLEAN NOT NULL DEFAULT true;
