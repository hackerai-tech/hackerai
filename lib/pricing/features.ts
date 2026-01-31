import type React from "react";
import { Check } from "lucide-react";

/**
 * Centralized pricing configuration for all plans.
 * Prices are in USD.
 */
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

export type PricingFeature = {
  icon: React.ComponentType<{ className?: string }>;
  text: string;
};

export const PLAN_HEADERS = {
  free: null,
  pro: "Everything in Free, plus:",
  "pro-plus": "Everything in Pro, plus:",
  ultra: "Everything in Pro, plus:",
  team: "Everything in Pro, plus:",
} as const;

export const freeFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Access to basic AI model" },
  { icon: Check, text: "Limited responses" },
];

export const proFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Access to smartest AI model" },
  { icon: Check, text: "Extended limits" },
  { icon: Check, text: "File uploads" },
  { icon: Check, text: "Agent mode with terminal" },
  { icon: Check, text: "Maximum context window" },
];

export const proPlusFeatures: Array<PricingFeature> = [
  { icon: Check, text: "3x more usage than Pro" },
];

export const ultraFeatures: Array<PricingFeature> = [
  { icon: Check, text: "20x more usage than Pro" },
  { icon: Check, text: "Priority access to new features" },
];

export const teamFeatures: Array<PricingFeature> = [
  { icon: Check, text: "2x more usage than Pro" },
  { icon: Check, text: "Centralized billing and invoicing" },
  { icon: Check, text: "Advanced team + seat management" },
];
