import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import {
  createFirstTouchAttribution,
  serializeFirstTouchAttribution,
} from "../acquisition";
import {
  parseFirstTouchAttributionCookie,
  serializeSignedFirstTouchAttribution,
} from "../acquisition-cookie";

const originalCookiePassword = process.env.WORKOS_COOKIE_PASSWORD;

describe("signed first-touch attribution cookie", () => {
  const capturedAt = new Date("2026-08-30T12:00:00.000Z");
  const attribution = createFirstTouchAttribution({
    url: new URL(
      "https://hackerai.co/?utm_source=github&utm_medium=social&utm_campaign=launch",
    ),
    referer: "https://github.com/hackerai-tech",
    capturedAt,
  });

  beforeEach(() => {
    process.env.WORKOS_COOKIE_PASSWORD =
      "test-cookie-password-with-32-characters";
  });

  afterEach(() => {
    if (originalCookiePassword === undefined) {
      delete process.env.WORKOS_COOKIE_PASSWORD;
    } else {
      process.env.WORKOS_COOKIE_PASSWORD = originalCookiePassword;
    }
  });

  it("round-trips a signed allowlisted payload", () => {
    const value = serializeSignedFirstTouchAttribution(attribution);

    expect(value).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(parseFirstTouchAttributionCookie(value ?? undefined)).toEqual(
      attribution,
    );
    expect(value).not.toContain("github.com");
  });

  it("rejects a tampered payload or signature", () => {
    const value = serializeSignedFirstTouchAttribution(attribution)!;
    const [prefix, payload, signature] = value.split(".");

    expect(
      parseFirstTouchAttributionCookie(`${prefix}.${payload}x.${signature}`),
    ).toBeNull();
    expect(
      parseFirstTouchAttributionCookie(`${prefix}.${payload}.${signature}x`),
    ).toBeNull();
  });

  it("does not mint cookies when AuthKit's server secret is unavailable", () => {
    delete process.env.WORKOS_COOKIE_PASSWORD;

    expect(serializeSignedFirstTouchAttribution(attribution)).toBeNull();
  });

  it("accepts bounded legacy cookies only during their migration window", () => {
    const legacy = serializeFirstTouchAttribution(attribution);

    expect(
      parseFirstTouchAttributionCookie(
        legacy,
        new Date("2026-10-01T00:00:00.000Z"),
      ),
    ).toEqual(attribution);
    expect(
      parseFirstTouchAttributionCookie(
        legacy,
        new Date("2026-11-15T00:00:00.000Z"),
      ),
    ).toBeNull();
  });
});
