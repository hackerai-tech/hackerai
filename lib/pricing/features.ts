import type React from "react";
import {
  Sparkle,
  MessagesSquare,
  Brain,
  Clock,
  Upload,
  FlaskConical,
  SquareTerminal,
  Key,
} from "lucide-react";

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
  { icon: FlaskConical, text: "Research preview of new features" },
];
