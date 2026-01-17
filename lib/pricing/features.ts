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
  ultra: "Everything in Pro, plus:",
  team: "Everything in Pro, plus:",
} as const;

export const freeFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Access to basic AI model" },
  { icon: Check, text: "Limited and slower responses" },
  { icon: Check, text: "Basic memory and context" },
];

export const proFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Access to smartest AI model" },
  { icon: Check, text: "Expanded messaging" },
  { icon: Check, text: "Access to file uploads" },
  { icon: Check, text: "Agent mode with terminal" },
  { icon: Check, text: "Connect agent to your machine" },
  { icon: Check, text: "Expanded memory and context" },
];

export const ultraFeatures: Array<PricingFeature> = [
  { icon: Check, text: "20x more usage than Pro" },
  { icon: Check, text: "Maximum memory and context" },
  { icon: Check, text: "Expanded Agent mode" },
  { icon: Check, text: "Early access to beta features" },
];

export const teamFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Centralized billing and invoicing" },
  { icon: Check, text: "Advanced team + seat management" },
];
