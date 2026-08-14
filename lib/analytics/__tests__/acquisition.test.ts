import { describe, expect, it } from "@jest/globals";
import {
  createFirstTouchAttribution,
  firstTouchPersonProperties,
  parseFirstTouchAttribution,
  serializeFirstTouchAttribution,
} from "../acquisition";

describe("first-touch acquisition attribution", () => {
  const capturedAt = new Date("2026-08-14T12:00:00.000Z");

  it("keeps bounded campaign metadata without URLs or search terms", () => {
    const attribution = createFirstTouchAttribution({
      url: new URL(
        "https://hackerai.co/?utm_source=newsletter&utm_medium=email&utm_campaign=aug_launch&utm_term=private-target",
      ),
      referer: "https://mail.example/path?secret=value",
      capturedAt,
    });

    expect(attribution).toEqual({
      version: 1,
      source: "newsletter",
      medium: "email",
      campaign: "aug_launch",
      referringDomain: "mail.example",
      entrySurface: "home",
      capturedAt: capturedAt.toISOString(),
    });
    expect(JSON.stringify(attribution)).not.toContain("private-target");
    expect(JSON.stringify(attribution)).not.toContain("secret");
  });

  it("classifies organic, referral, paid, and direct entry", () => {
    expect(
      createFirstTouchAttribution({
        url: new URL("https://hackerai.co/download"),
        referer: "https://www.google.com/search?q=hackerai",
        capturedAt,
      }),
    ).toMatchObject({
      source: "google",
      medium: "organic",
      referringDomain: "google.com",
      entrySurface: "download",
    });
    expect(
      createFirstTouchAttribution({
        url: new URL("https://hackerai.co/?ref=SAFE123"),
        referer: null,
        capturedAt,
      }),
    ).toMatchObject({ source: "user_referral", medium: "referral" });
    expect(
      createFirstTouchAttribution({
        url: new URL("https://hackerai.co/?gclid=opaque-click-id"),
        referer: null,
        capturedAt,
      }),
    ).toMatchObject({ source: "google", medium: "paid" });
    expect(
      createFirstTouchAttribution({
        url: new URL("https://hackerai.co/"),
        referer: "https://signin.hackerai.co/callback",
        capturedAt,
      }),
    ).toMatchObject({
      source: "$direct",
      medium: "none",
      referringDomain: "$direct",
    });
  });

  it("round-trips valid values and rejects tampered cookies", () => {
    const attribution = createFirstTouchAttribution({
      url: new URL("https://hackerai.co/?utm_source=partner"),
      referer: "https://partner.example/path",
      capturedAt,
    });
    expect(
      parseFirstTouchAttribution(serializeFirstTouchAttribution(attribution)),
    ).toEqual(attribution);
    expect(parseFirstTouchAttribution("not-json")).toBeNull();
    expect(
      parseFirstTouchAttribution(
        encodeURIComponent(
          JSON.stringify({ ...attribution, source: "unsafe value" }),
        ),
      ),
    ).toBeNull();
  });

  it("maps attribution to set-once person properties", () => {
    const attribution = createFirstTouchAttribution({
      url: new URL("https://hackerai.co/trust?utm_source=github"),
      referer: "https://github.com/hackerai-tech",
      capturedAt,
    });

    expect(firstTouchPersonProperties(attribution)).toEqual({
      first_touch_attribution_version: 1,
      first_touch_source: "github",
      first_touch_medium: "campaign",
      first_touch_referring_domain: "github.com",
      first_touch_entry_surface: "trust",
      first_touch_captured_at: capturedAt.toISOString(),
    });
  });
});
