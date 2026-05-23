import {
  attributionProperties,
  buildInitialAttribution,
  decodeAttributionCookie,
  encodeAttributionCookie,
  sanitizeAttribution,
  stripeAttributionMetadata,
} from "../attribution";

describe("attribution", () => {
  it("captures UTM first-touch values from the landing URL", () => {
    const attribution = buildInitialAttribution({
      href: "https://hackerai.co/?utm_source=Google&utm_medium=CPC&utm_campaign=Launch&gclid=abc123&email=test@example.com",
      capturedAt: "2026-05-23T12:00:00.000Z",
    });

    expect(attribution).toEqual(
      expect.objectContaining({
        initial_source: "google",
        initial_medium: "cpc",
        initial_campaign: "launch",
        initial_landing_page: "https://hackerai.co/",
        initial_landing_path: "/",
        initial_landing_query:
          "utm_source=Google&utm_medium=CPC&utm_campaign=Launch&gclid=abc123",
        initial_gclid: "abc123",
        initial_captured_at: "2026-05-23T12:00:00.000Z",
      }),
    );
    expect(attribution?.initial_landing_query).not.toContain("email=");
  });

  it("falls back to an external referrer when no UTM source exists", () => {
    const attribution = buildInitialAttribution({
      href: "https://hackerai.co/pricing",
      referrer: "https://www.producthunt.com/posts/hackerai",
      capturedAt: "2026-05-23T12:00:00.000Z",
    });

    expect(attribution).toEqual(
      expect.objectContaining({
        initial_source: "producthunt.com",
        initial_medium: "referral",
        initial_referring_domain: "producthunt.com",
        initial_landing_path: "/pricing",
      }),
    );
  });

  it("sanitizes untrusted attribution payloads before server capture", () => {
    const sanitized = sanitizeAttribution({
      initial_source: "x".repeat(600),
      initial_medium: "referral",
      initial_landing_page: "https://hackerai.co/",
      initial_landing_path: "/",
      initial_captured_at: "2026-05-23T12:00:00.000Z",
      ignored: "value",
    });

    expect(sanitized?.initial_source).toHaveLength(500);
    expect(attributionProperties(sanitized)).not.toHaveProperty("ignored");
    expect(stripeAttributionMetadata(sanitized)).toEqual(
      expect.objectContaining({
        initial_source: "x".repeat(500),
        initial_medium: "referral",
      }),
    );
  });

  it("decodes raw and URL-encoded cookie values", () => {
    const attribution = buildInitialAttribution({
      href: "https://hackerai.co/?utm_source=x&utm_medium=social",
      capturedAt: "2026-05-23T12:00:00.000Z",
    });
    const cookieValue = encodeAttributionCookie(attribution);

    expect(decodeAttributionCookie(cookieValue)?.initial_source).toBe("x");
    expect(
      decodeAttributionCookie(encodeURIComponent(cookieValue ?? ""))
        ?.initial_medium,
    ).toBe("social");
  });
});
