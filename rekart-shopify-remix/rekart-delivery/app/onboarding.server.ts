import db from "./db.server";
import type { ShopOnboarding } from "@prisma/client";
import type { OnboardingInput } from "./onboarding-options";

export async function getOnboarding(
  shop: string,
): Promise<ShopOnboarding | null> {
  return db.shopOnboarding.findUnique({ where: { shop } });
}

export async function saveOnboarding(
  shop: string,
  input: OnboardingInput,
): Promise<ShopOnboarding> {
  return db.shopOnboarding.upsert({
    where: { shop },
    create: { shop, ...input, completed: true },
    update: { ...input, completed: true },
  });
}
