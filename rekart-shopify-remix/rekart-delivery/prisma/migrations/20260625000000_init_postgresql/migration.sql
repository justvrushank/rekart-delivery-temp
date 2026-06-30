-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopOnboarding" (
    "shop" TEXT NOT NULL,
    "businessCategory" TEXT,
    "country" TEXT,
    "orderVolume" TEXT,
    "subscriberCount" TEXT,
    "deliveryOps" TEXT,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "connected" BOOLEAN NOT NULL DEFAULT false,
    "existingRekartUser" BOOLEAN,
    "rekartMerchantId" TEXT,
    "rekartAccessToken" TEXT,
    "tokenInvalid" BOOLEAN NOT NULL DEFAULT false,
    "defaultSlotId" INTEGER,
    "rekartTokenExpiresAt" TIMESTAMP(3),
    "rekartOAuthState" TEXT,
    "rekartCacheId" TEXT,
    "rekartCurrency" TEXT,
    "rekartCurrencySymbol" TEXT,
    "rekartTimezone" TEXT,
    "rekartTerritoryId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopOnboarding_pkey" PRIMARY KEY ("shop")
);

-- CreateTable
CREATE TABLE "FulfillmentPush" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "rekartStatus" TEXT NOT NULL,
    "rekartDeliveryId" TEXT,
    "mappedAction" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "shopifyFulfillmentId" TEXT,
    "trackingNumber" TEXT,
    "trackingUrl" TEXT,
    "trackingCompany" TEXT,
    "occurredAt" TIMESTAMP(3),
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FulfillmentPush_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GdprRequest" (
    "id" SERIAL NOT NULL,
    "shop" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retriedAt" TIMESTAMP(3),
    "retryCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "GdprRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyProductLink" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyVariantId" TEXT NOT NULL,
    "shopifyProductTitle" TEXT NOT NULL,
    "shopifySku" TEXT,
    "rekartProductId" INTEGER NOT NULL,
    "rekartProductName" TEXT,
    "matchedAuto" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyProductLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FulfillmentLink" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyFulfillmentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FulfillmentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyOrderSync" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "rekartOrderId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyOrderSync_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ShopifyCustomerSync" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "shopifyCustomerId" TEXT NOT NULL,
    "rekartUserId" TEXT,
    "rekartAddressId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyCustomerSync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "FulfillmentPush_status_nextAttemptAt_idx" ON "FulfillmentPush"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "FulfillmentPush_shop_createdAt_idx" ON "FulfillmentPush"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentPush_shop_shopifyOrderId_rekartStatus_rekartDeli_key" ON "FulfillmentPush"("shop", "shopifyOrderId", "rekartStatus", "rekartDeliveryId");

-- CreateIndex
CREATE INDEX "GdprRequest_shop_status_idx" ON "GdprRequest"("shop", "status");

-- CreateIndex
CREATE INDEX "ShopifyProductLink_shopId_idx" ON "ShopifyProductLink"("shopId");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyProductLink_shopId_shopifyVariantId_key" ON "ShopifyProductLink"("shopId", "shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "FulfillmentLink_shop_shopifyOrderId_key" ON "FulfillmentLink"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "ShopifyOrderSync_status_nextAttemptAt_idx" ON "ShopifyOrderSync"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "ShopifyOrderSync_shop_createdAt_idx" ON "ShopifyOrderSync"("shop", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyOrderSync_shop_shopifyOrderId_key" ON "ShopifyOrderSync"("shop", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "ShopifyCustomerSync_shop_idx" ON "ShopifyCustomerSync"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyCustomerSync_shop_shopifyCustomerId_key" ON "ShopifyCustomerSync"("shop", "shopifyCustomerId");

