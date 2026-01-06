import type React from "react";
import {
  Sparkle,
  MessagesSquare,
  Brain,
  Clock,
  Upload,
  FlaskConical,
  SquareTerminal,
  CreditCard,
  Users,
  Code,
} from "lucide-react";

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

export const freeFeatures: Array<PricingFeature> = [
  { icon: Sparkle, text: "Access to basic AI model" },
  { icon: Clock, text: "Limited and slower responses" },
  { icon: Brain, text: "Basic memory and context" },
];

export const proFeatures: Array<PricingFeature> = [
  { icon: Sparkle, text: "Access to smartest AI model" },
  { icon: MessagesSquare, text: "Expanded messaging" },
  { icon: Upload, text: "Access to file uploads" },
  { icon: SquareTerminal, text: "Agent mode with terminal" },
  { icon: Brain, text: "Expanded memory and context" },
];

export const ultraFeatures: Array<PricingFeature> = [
  { icon: MessagesSquare, text: "Unlimited messages and uploads" },
  { icon: Brain, text: "Maximum memory and context" },
  { icon: SquareTerminal, text: "Expanded Agent mode" },
  { icon: FlaskConical, text: "Research preview of new features" },
];

export const teamFeatures: Array<PricingFeature> = [
  {
    icon: Sparkle,
    text: "Everything in Pro and more: access to smartest AI model, expanded messaging, file uploads, agent mode with terminal, expanded memory and context",
  },
  { icon: CreditCard, text: "Centralized billing and invoicing" },
  { icon: Users, text: "Advanced team + seat management" },
];
