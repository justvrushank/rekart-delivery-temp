// Client- and server-safe onboarding constants, types and validation.
// No DB or server-only imports here so it can be used inside route components.

export const BUSINESS_CATEGORIES = [
  "Food & Beverage",
  "Grocery",
  "Pharmacy",
  "Fashion & Apparel",
  "Electronics",
  "Health & Beauty",
  "Home & Living",
  "Other",
] as const;

export const ORDER_VOLUMES = [
  { value: "0-50", label: "0 – 50 orders / month" },
  { value: "51-200", label: "51 – 200 orders / month" },
  { value: "201-1000", label: "201 – 1,000 orders / month" },
  { value: "1000+", label: "1,000+ orders / month" },
] as const;

export const SUBSCRIBER_COUNTS = [
  { value: "0-100", label: "0 – 100 subscribers" },
  { value: "101-1000", label: "101 – 1,000 subscribers" },
  { value: "1001-10000", label: "1,001 – 10,000 subscribers" },
  { value: "10000+", label: "10,000+ subscribers" },
] as const;

export const DELIVERY_OPS = [
  { value: "own_fleet", label: "We run our own delivery fleet" },
  { value: "third_party", label: "We use third-party couriers" },
  { value: "mixed", label: "A mix of own fleet and couriers" },
  { value: "none", label: "We don't have delivery set up yet" },
] as const;

export interface OnboardingInput {
  // Yes/No fork: true = existing Rekart client, false = new to Rekart.
  existingRekartUser: boolean;
  businessCategory: string;
  country: string;
  orderVolume: string;
  subscriberCount: string;
  deliveryOps: string;
}

// Returns a map of field -> error message; empty object means valid.
export function validateOnboarding(
  input: Partial<OnboardingInput>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const required: (keyof OnboardingInput)[] = [
    "businessCategory",
    "country",
    "orderVolume",
    "subscriberCount",
    "deliveryOps",
  ];
  for (const field of required) {
    if (!input[field]) errors[field] = "This field is required.";
  }
  return errors;
}
