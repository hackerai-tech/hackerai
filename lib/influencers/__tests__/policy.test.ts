import {
  anniversary,
  commissionCents,
  ATTRIBUTION_DAYS,
  validPartnerCode,
} from "../policy";
import { partnerCookie, readPartnerCookie } from "../cookie";

describe("influencer policy and signed links", () => {
  beforeEach(() => {
    process.env.WORKOS_COOKIE_PASSWORD = "test-partner-signing-secret";
  });
  it("rounds down in integer cents and rejects invalid money", () => {
    expect(commissionCents(2500, 1500)).toBe(375);
    expect(commissionCents(999, 1500)).toBe(149);
    expect(() => commissionCents(-1, 1500)).toThrow();
    expect(() => commissionCents(100, 10001)).toThrow();
  });
  it("uses a calendar year including leap-day clamping", () => {
    expect(
      new Date(anniversary(Date.parse("2024-02-29T12:00:00Z"))).toISOString(),
    ).toBe("2025-02-28T12:00:00.000Z");
  });
  it("accepts short slugs but rejects paths and ambiguous characters", () => {
    expect(validPartnerCode("medusa")).toBe(true);
    for (const code of ["a", "../a", "a/b", "x?y", "MEDUSA", "a".repeat(25)])
      expect(validPartnerCode(code)).toBe(false);
  });
  it("rejects tampering, future clicks, and cookies at the 30-day boundary", () => {
    const now = 1_700_000_000_000;
    const cookie = partnerCookie("medusa", now);
    expect(readPartnerCookie(cookie, now + 1)).toEqual({
      code: "medusa",
      clickedAt: now,
    });
    expect(
      readPartnerCookie(cookie.replace("medusa", "another"), now + 1),
    ).toBeNull();
    expect(readPartnerCookie(cookie, now - 1)).toBeNull();
    expect(
      readPartnerCookie(cookie, now + ATTRIBUTION_DAYS * 86400_000),
    ).toBeNull();
  });
});
