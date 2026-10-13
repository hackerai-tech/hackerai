/** Public plan prices for new customers in USD, expressed as monthly amounts. */
export const PRICING = {
  pro: {
    monthly: 29,
    yearly: 24,
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
