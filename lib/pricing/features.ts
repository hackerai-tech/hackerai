import type React from "react";
import { Check } from "lucide-react";

export { PRICING, type PricingTier } from "./config";

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
  { icon: Check, text: "Agent mode with local sandbox" },
];

export const proFeatures: Array<PricingFeature> = [
  { icon: Check, text: "Access to the best AI models for pentesting" },
  { icon: Check, text: "Extended limits" },
  { icon: Check, text: "File uploads" },
  { icon: Check, text: "Cloud agents" },
  { icon: Check, text: "Maximum context window" },
];

export const proPlusFeatures: Array<PricingFeature> = [
  { icon: Check, text: "3x more usage than Pro" },
];

export const ultraFeatures: Array<PricingFeature> = [
  { icon: Check, text: "10x more usage than Pro" },
  { icon: Check, text: "Priority access to new features" },
];

export const teamFeatures: Array<PricingFeature> = [
  { icon: Check, text: "2x more usage than Pro" },
  { icon: Check, text: "Centralized billing and invoicing" },
  { icon: Check, text: "Advanced team + seat management" },
];
