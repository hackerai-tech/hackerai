import { z } from "zod";
import {
  DEFAULT_ANNUAL_BPS,
  DEFAULT_MONTHLY_BPS,
  validPartnerCode,
} from "./policy";

export const partnerRequestSchema = z
  .object({
    targetUrl: z.url(),
    stripeAccountId: z.string().startsWith("acct_"),
    live: z.boolean(),
    code: z.string().refine(validPartnerCode),
    name: z.string().trim().min(1).max(100),
    email: z
      .email()
      .max(254)
      .transform((email) => email.toLowerCase()),
    monthlyBps: z.number().int().min(0).max(10000).default(DEFAULT_MONTHLY_BPS),
    annualBps: z.number().int().min(0).max(10000).default(DEFAULT_ANNUAL_BPS),
  })
  .strict();

// Operator credentials must never follow redirects or travel over public HTTP.
export function partnerProvisioningUrl(base: string): URL {
  const url = new URL(base);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" &&
      !(
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      ))
  ) {
    throw new Error(
      "Partner creation requires HTTPS (HTTP is allowed only on localhost)",
    );
  }
  return new URL("/api/internal/influencers/partners", url.origin);
}
