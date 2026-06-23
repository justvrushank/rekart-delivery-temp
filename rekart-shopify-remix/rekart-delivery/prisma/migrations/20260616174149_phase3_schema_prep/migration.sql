-- AlterTable
ALTER TABLE `ShopOnboarding` ADD COLUMN `rekartOAuthState` VARCHAR(191) NULL;

-- CreateTable
CREATE TABLE `ShopifyOrderSync` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `shopifyOrderId` VARCHAR(191) NOT NULL,
    `rekartOrderId` VARCHAR(191) NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `nextAttemptAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShopifyOrderSync_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `ShopifyOrderSync_shop_createdAt_idx`(`shop`, `createdAt`),
    UNIQUE INDEX `ShopifyOrderSync_shop_shopifyOrderId_key`(`shop`, `shopifyOrderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ShopifyCustomerSync` (
    `id` VARCHAR(191) NOT NULL,
    `shop` VARCHAR(191) NOT NULL,
    `shopifyCustomerId` VARCHAR(191) NOT NULL,
    `rekartUserId` VARCHAR(191) NULL,
    `rekartAddressId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ShopifyCustomerSync_shop_idx`(`shop`),
    UNIQUE INDEX `ShopifyCustomerSync_shop_shopifyCustomerId_key`(`shop`, `shopifyCustomerId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `Session_shop_idx` ON `Session`(`shop`);

