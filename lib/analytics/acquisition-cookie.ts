import "server-only";

import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";
import {
  parseFirstTouchAttribution,
  type FirstTouchAttribution,
} from "@/lib/analytics/acquisition";

const SIGNED_COOKIE_PREFIX = "v1";
const SIGNING_CONTEXT = "hackerai:first-touch-attribution-cookie:v1";
const LEGACY_COOKIE_ACCEPT_UNTIL = Date.parse("2026-11-15T00:00:00.000Z");

function signingKey(): Buffer | null {
  const secret = process.env.WORKOS_COOKIE_PASSWORD;
  if (!secret) return null;

  return Buffer.from(
    hkdfSync("sha256", secret, "hackerai-acquisition", SIGNING_CONTEXT, 32),
  );
}

function signatureFor(payload: string, key: Buffer): string {
  return createHmac("sha256", key).update(payload).digest("base64url");
}

export function serializeSignedFirstTouchAttribution(
  attribution: FirstTouchAttribution,
): string | null {
  const key = signingKey();
  if (!key) return null;

  const payload = Buffer.from(JSON.stringify(attribution)).toString(
    "base64url",
  );
  return `${SIGNED_COOKIE_PREFIX}.${payload}.${signatureFor(payload, key)}`;
}

function parseSignedFirstTouchAttribution(
  value: string,
): FirstTouchAttribution | null {
  const key = signingKey();
  if (!key) return null;

  const [prefix, payload, suppliedSignature, ...extra] = value.split(".");
  if (
    prefix !== SIGNED_COOKIE_PREFIX ||
    !payload ||
    !suppliedSignature ||
    extra.length > 0
  ) {
    return null;
  }

  const expectedSignature = signatureFor(payload, key);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (
    supplied.length !== expected.length ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null;
  }

  try {
    return parseFirstTouchAttribution(
      encodeURIComponent(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    return null;
  }
}

export function parseFirstTouchAttributionCookie(
  value: string | undefined,
  now = new Date(),
): FirstTouchAttribution | null {
  if (!value || value.length > 2_048) return null;

  const signed = parseSignedFirstTouchAttribution(value);
  if (signed) return signed;

  // Cookies written before signed attribution shipped remain useful during
  // their original 90-day lifetime. Values are still strictly allowlisted by
  // parseFirstTouchAttribution. Remove this compatibility path after cutoff.
  if (now.getTime() < LEGACY_COOKIE_ACCEPT_UNTIL) {
    return parseFirstTouchAttribution(value);
  }

  return null;
}
