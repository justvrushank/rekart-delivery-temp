-- CreateTable
CREATE TABLE `Session` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `state` VARCHAR(191) NOT NULL,
    `isOnline` BOOLEAN NOT NULL DEFAULT false,
    `scope` VARCHAR(191) NULL,
    `expires` DATETIME(3) NULL,
    `accessToken` VARCHAR(191) NOT NULL,
    `userId` BIGINT NULL,
    `firstName` VARCHAR(191) NULL,
    `lastName` VARCHAR(191) NULL,
    `email` VARCHAR(191) NULL,
    `accountOwner` BOOLEAN NOT NULL DEFAULT false,
    `locale` VARCHAR(191) NULL,
    `collaborator` BOOLEAN NULL DEFAULT false,
    `emailVerified` BOOLEAN NULL DEFAULT false,
    `refreshToken` VARCHAR(191) NULL,
    `refreshTokenExpires` DATETIME(3) NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopOnboarding` (
    `shop` VARCHAR(191) NOT NULL,
    `businessCategory` VARCHAR(191) NULL,
    `country` VARCHAR(191) NULL,
    `orderVolume` VARCHAR(191) NULL,
    `subscriberCount` VARCHAR(191) NULL,
    `deliveryOps` VARCHAR(191) NULL,
    `completed` BOOLEAN NOT NULL DEFAULT false,
    `connected` BOOLEAN NOT NULL DEFAULT false,
    `existingRekartUser` BOOLEAN NULL,
    `rekartMerchantId` VARCHAR(191) NULL,
    `rekartAccessToken` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`shop`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FulfillmentPush` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `shopifyOrderId` VARCHAR(191) NOT NULL,
    `rekartStatus` VARCHAR(191) NOT NULL,
    `rekartDeliveryId` VARCHAR(191) NULL,
    `mappedAction` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `shopifyFulfillmentId` VARCHAR(191) NULL,
    `trackingNumber` VARCHAR(191) NULL,
    `trackingUrl` TEXT NULL,
    `trackingCompany` VARCHAR(191) NULL,
    `occurredAt` DATETIME(3) NULL,
    `nextAttemptAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `FulfillmentPush_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `FulfillmentPush_shop_createdAt_idx`(`shop`, `createdAt`),
    UNIQUE INDEX `FulfillmentPush_shop_shopifyOrderId_rekartStatus_key`(`shop`, `shopifyOrderId`, `rekartStatus`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `GdprRequest` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `shop` VARCHAR(191) NOT NULL,
    `topic` VARCHAR(191) NOT NULL,
    `payload` TEXT NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `retriedAt` DATETIME(3) NULL,
    `retryCount` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopifyProductLink` (
    `id` VARCHAR(191) NOT NULL,
    `shopId` VARCHAR(191) NOT NULL,
    `shopifyVariantId` VARCHAR(191) NOT NULL,
    `shopifyProductTitle` TEXT NOT NULL,
    `shopifySku` VARCHAR(191) NULL,
    `rekartProductId` INTEGER NOT NULL,
    `rekartProductName` TEXT NULL,
    `matchedAuto` BOOLEAN NOT NULL DEFAULT false,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShopifyProductLink_shopId_idx`(`shopId`),
    UNIQUE INDEX `ShopifyProductLink_shopId_shopifyVariantId_key`(`shopId`, `shopifyVariantId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `FulfillmentLink` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `shopifyOrderId` VARCHAR(191) NOT NULL,
    `shopifyFulfillmentId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `FulfillmentLink_shop_shopifyOrderId_key`(`shop`, `shopifyOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

