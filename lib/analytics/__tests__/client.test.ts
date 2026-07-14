import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockCapture = jest.fn();
const mockPostHog = {
  __loaded: true,
  capture: mockCapture,
  get_distinct_id: jest.fn(() => "user_123"),
};

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: mockPostHog,
}));

const { captureUpgradeCtaImpression, loadPostHogClient } =
  require("../client") as typeof import("../client");

describe("client analytics", () => {
  beforeAll(async () => {
    process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test";
    await loadPostHogClient();
  });

  beforeEach(() => {
    window.localStorage.clear();
    mockCapture.mockClear();
    jest.useFakeTimers().setSystemTime(new Date("2026-07-14T12:00:00Z"));
  });

  it("captures each upgrade impression surface and source once per UTC day", () => {
    const properties = {
      surface: "chat_header",
      source: "upgrade_button",
      from_tier: "free",
    };

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(captureUpgradeCtaImpression(properties)).toBe(false);
    expect(mockCapture).toHaveBeenCalledTimes(1);

    expect(
      captureUpgradeCtaImpression({
        ...properties,
        source: "mobile_menu",
      }),
    ).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(2);

    jest.setSystemTime(new Date("2026-07-15T00:00:01Z"));
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(3);
  });
});
