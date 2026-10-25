import type { PostHog } from "posthog-js";
import {
  captureXReferralVisit,
  isXReferralLanding,
  sanitizeXReferralEvent,
  xReferringDomain,
} from "../x-referral";

describe("plain-link X referrals", () => {
  beforeEach(() => {
    localStorage.clear();
    jest
      .spyOn(document, "referrer", "get")
      .mockReturnValue("https://t.co/private-post");
    jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0");
  });
  afterEach(() => jest.restoreAllMocks());

  it("accepts X hosts without treating lookalike domains or UTM tags as referral evidence", () => {
    for (const url of [
      "https://t.co/abc",
      "https://X.com/name/status/123",
      "https://mobile.twitter.com/",
    ]) {
      expect(xReferringDomain(url)).not.toBeNull();
    }
    for (const url of [
      "https://notx.com/",
      "https://x.com.attacker.test/",
      "https://example.com/?utm_source=x",
      "",
      "javascript:alert(1)",
    ]) {
      expect(xReferringDomain(url)).toBeNull();
    }
  });

  it("does not count a link-preview crawler as a visitor", () => {
    jest.spyOn(navigator, "userAgent", "get").mockReturnValue("Twitterbot/1.0");
    expect(isXReferralLanding()).toBe(false);
  });

  it("deduplicates remounts and reloads while keeping retry UUIDs stable", () => {
    const capture = jest.fn().mockReturnValue({});
    const client = {
      capture,
      get_distinct_id: () => "anonymous-visitor",
    } as unknown as PostHog;
    expect(captureXReferralVisit(client)).toBe(true);
    expect(captureXReferralVisit(client)).toBe(true);
    expect(capture).toHaveBeenCalledTimes(1);
    const uuid = capture.mock.calls[0][2].uuid;
    localStorage.clear();
    captureXReferralVisit(client);
    expect(capture.mock.calls[1][2].uuid).toBe(uuid);
    expect(capture.mock.calls[0][1]).toMatchObject({
      source: "x",
      referring_domain: "t.co",
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain("private-post");
  });

  it("does not mark a dropped capture as delivered", () => {
    const capture = jest
      .fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValue({});
    const client = {
      capture,
      get_distinct_id: () => "visitor",
    } as unknown as PostHog;
    expect(captureXReferralVisit(client)).toBe(false);
    expect(captureXReferralVisit(client)).toBe(true);
    expect(capture.mock.calls[0][2].uuid).toBe(capture.mock.calls[1][2].uuid);
  });

  it("removes SDK-added URLs, person data and superprops from referral events", () => {
    const event = sanitizeXReferralEvent({
      event: "x_referral_visit",
      properties: {
        distinct_id: "visitor",
        source: "x",
        referring_domain: "t.co",
        $current_url: "https://hackerai.co/chat/private?token=secret",
        $referrer: "https://t.co/private-post",
        email: "private@example.com",
        prompt: "private",
        $set: { name: "private" },
        $set_once: { path: "private" },
      },
      $set: { email: "private@example.com" },
      $set_once: { url: "private" },
    });
    expect(event).toEqual({
      event: "x_referral_visit",
      properties: {
        distinct_id: "visitor",
        source: "x",
        referring_domain: "t.co",
        $geoip_disable: true,
      },
    });
  });
});
