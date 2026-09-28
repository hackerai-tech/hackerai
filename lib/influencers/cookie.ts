import { createHmac, timingSafeEqual } from "node:crypto";
import { ATTRIBUTION_DAYS, validPartnerCode } from "./policy";

function sign(payload: string): string {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) throw new Error("Partner cookie signing is not configured");
  return createHmac("sha256", secret)
    .update(`hackerai:influencer:v1:${payload}`)
    .digest("base64url");
}

export const INFLUENCER_VISITOR_COOKIE = "hackerai_partner_visitor";
const validVisitor = (id: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
    id,
  );

export function partnerCookie(
  code: string,
  now = Date.now(),
  visitorId?: string,
): string {
  if (!validPartnerCode(code)) throw new Error("Invalid partner code");
  if (visitorId && !validVisitor(visitorId))
    throw new Error("Invalid visitor ID");
  const payload = `${code}.${now}${visitorId ? `.${visitorId}` : ""}`;
  return `${payload}.${sign(payload)}`;
}

export function readPartnerCookie(value: string | undefined, now = Date.now()) {
  if (!value || value.length > 200) return null;
  const parts = value.split(".");
  const [code, timestamp] = parts;
  const visitorId = parts.length === 4 ? parts[2] : undefined;
  const signature = parts.at(-1);
  const clickedAt = Number(timestamp);
  if (
    (parts.length !== 3 && parts.length !== 4) ||
    (visitorId !== undefined && !validVisitor(visitorId)) ||
    !code ||
    !signature ||
    !validPartnerCode(code) ||
    !Number.isSafeInteger(clickedAt) ||
    clickedAt > now ||
    now - clickedAt >= ATTRIBUTION_DAYS * 86400_000
  )
    return null;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(sign(parts.slice(0, -1).join(".")));
  return actual.length === expected.length && timingSafeEqual(actual, expected)
    ? { code, clickedAt, ...(visitorId ? { visitorId } : {}) }
    : null;
}
