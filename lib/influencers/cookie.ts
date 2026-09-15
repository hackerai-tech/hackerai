import { createHmac, timingSafeEqual } from "node:crypto";
import { ATTRIBUTION_DAYS, validPartnerCode } from "./policy";

function sign(payload: string): string {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new Error("Partner cookie signing is not configured");
  return createHmac("sha256", secret)
    .update(`hackerai:influencer:v1:${payload}`)
    .digest("base64url");
}

export function partnerCookie(code: string, now = Date.now()): string {
  if (!validPartnerCode(code)) throw new Error("Invalid partner code");
  const payload = `${code}.${now}`;
  return `${payload}.${sign(payload)}`;
}

export function readPartnerCookie(value: string | undefined, now = Date.now()) {
  if (!value || value.length > 200) return null;
  const [code, timestamp, signature, extra] = value.split(".");
  const clickedAt = Number(timestamp);
  if (
    extra ||
    !code ||
    !signature ||
    !validPartnerCode(code) ||
    !Number.isSafeInteger(clickedAt) ||
    clickedAt > now ||
    now - clickedAt >= ATTRIBUTION_DAYS * 86400_000
  )
    return null;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(`${code}.${timestamp}`));
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { code, clickedAt }
    : null;
}
