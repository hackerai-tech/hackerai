import { describe, it, expect } from "@jest/globals";
import { isProMaxUsageNoticeDismissedFromCookieHeader } from "../pro-max-notice-cookie";

describe("pro-max-notice-cookie", () => {
  describe("isProMaxUsageNoticeDismissedFromCookieHeader", () => {
    it("returns false when empty", () => {
      expect(isProMaxUsageNoticeDismissedFromCookieHeader("")).toBe(false);
    });

    it("returns true when the ack cookie appears first", () => {
      expect(
        isProMaxUsageNoticeDismissedFromCookieHeader(
          "zhacker_pro_max_usage_ack=1",
        ),
      ).toBe(true);
    });

    it("returns true when the ack cookie follows another cookie", () => {
      expect(
        isProMaxUsageNoticeDismissedFromCookieHeader(
          "sidebar=open; zhacker_pro_max_usage_ack=1",
        ),
      ).toBe(true);
    });

    it("does not match a prefixed cookie name substring", () => {
      expect(
        isProMaxUsageNoticeDismissedFromCookieHeader(
          "evil_zhacker_pro_max_usage_ack=1",
        ),
      ).toBe(false);
    });

    it("requires value 1", () => {
      expect(
        isProMaxUsageNoticeDismissedFromCookieHeader(
          "zhacker_pro_max_usage_ack=0",
        ),
      ).toBe(false);
    });
  });
});
