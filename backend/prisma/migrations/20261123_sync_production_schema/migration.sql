-- CreateEnum
CREATE TYPE "MetricPeriod" AS ENUM ('MONTHLY', 'HALFYEARLY', 'ANNUAL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN "joinedAt" TIMESTAMP(3),
ADD COLUMN "leftAt" TIMESTAMP(3),
ADD COLUMN "fcmToken" TEXT;

-- AlterTable
ALTER TABLE "BazaarItem" ADD COLUMN "rawText" TEXT,
ADD COLUMN "itemsDetail" JSONB,
ADD COLUMN "depositAmount" DOUBLE PRECISION DEFAULT 0.0,
ADD COLUMN "depositId" TEXT,
ADD COLUMN "rejectionReason" TEXT;

-- AlterTable
ALTER TABLE "Deposit" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'APPROVED',
ADD COLUMN "bazaarItemId" TEXT;

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SystemMetricSummary" (
    "id" TEXT NOT NULL,
    "period" "MetricPeriod" NOT NULL,
    "periodKey" TEXT NOT NULL,
    "routePath" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL,
    "totalRequests" INTEGER NOT NULL,
    "averageLatencyMs" DOUBLE PRECISION NOT NULL,
    "averageRamMb" DOUBLE PRECISION NOT NULL,
    "averageCpuMs" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SystemMetricSummary_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LearnedBazaarPattern" (
    "id" TEXT NOT NULL,
    "rawPhrase" TEXT NOT NULL,
    "canonicalName" TEXT NOT NULL,
    "defaultUnit" TEXT NOT NULL DEFAULT 'kg',
    "messId" TEXT,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0.95,
    "hitCount" INTEGER NOT NULL DEFAULT 1,
    "learnedFrom" TEXT NOT NULL DEFAULT 'AI_GEMINI',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LearnedBazaarPattern_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SystemMetricSummary_periodKey_idx" ON "SystemMetricSummary"("periodKey");

-- CreateIndex
CREATE INDEX "LearnedBazaarPattern_rawPhrase_idx" ON "LearnedBazaarPattern"("rawPhrase");

-- CreateIndex
CREATE INDEX "LearnedBazaarPattern_messId_idx" ON "LearnedBazaarPattern"("messId");

-- CreateIndex
CREATE UNIQUE INDEX "LearnedBazaarPattern_rawPhrase_messId_key" ON "LearnedBazaarPattern"("rawPhrase", "messId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LearnedBazaarPattern" ADD CONSTRAINT "LearnedBazaarPattern_messId_fkey" FOREIGN KEY ("messId") REFERENCES "Mess"("id") ON DELETE CASCADE ON UPDATE CASCADE;
