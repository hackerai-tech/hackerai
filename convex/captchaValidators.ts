import { v } from "convex/values";

export const captchaKind = v.union(
  v.literal("recaptcha_v2"),
  v.literal("hcaptcha"),
  v.literal("turnstile"),
);
export const captchaAttemptState = v.union(
  v.literal("creating"),
  v.literal("processing"),
  v.literal("ready"),
  v.literal("unsolvable"),
  v.literal("unknown"),
);
