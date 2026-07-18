import { validate as isUuid } from "uuid";
import { checkoutStartedEventUuid } from "@/lib/analytics/paid-funnel-server";

describe("paid funnel server analytics helpers", () => {
  it("creates one stable PostHog UUID per checkout attempt", () => {
    const first = checkoutStartedEventUuid("ca_attempt_123");

    expect(isUuid(first)).toBe(true);
    expect(checkoutStartedEventUuid("ca_attempt_123")).toBe(first);
    expect(checkoutStartedEventUuid("ca_retry_456")).not.toBe(first);
  });
});
