/** Centralized plan prices in USD, expressed as monthly amounts. */
export const PRICING = {
  pro: {
    monthly: 25,
    yearly: 21,
  },
  "pro-plus": {
    monthly: 60,
    yearly: 50,
  },
  ultra: {
    monthly: 200,
    yearly: 166,
  },
  team: {
    monthly: 40,
    yearly: 33,
  },
} as const;

export type PricingTier = keyof typeof PRICING;
