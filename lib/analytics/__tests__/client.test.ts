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
    mockPostHog.get_distinct_id.mockReturnValue("user_123");
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
    const firstUuid = mockCapture.mock.calls[0]?.[2]?.uuid;
    expect(mockCapture).toHaveBeenLastCalledWith(
      "upgrade_cta_impressed",
      expect.objectContaining({
        impression_dedupe_scope: "identified_user_surface_source_utc_day",
        impression_dedupe_version: 1,
        impression_utc_day: "2026-07-14",
      }),
      { uuid: expect.stringMatching(/^[0-9a-f-]{36}$/i) },
    );

    expect(
      captureUpgradeCtaImpression({
        ...properties,
        source: "mobile_menu",
      }),
    ).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(2);
    expect(mockCapture.mock.calls[1]?.[2]?.uuid).not.toBe(firstUuid);

    jest.setSystemTime(new Date("2026-07-15T00:00:01Z"));
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture).toHaveBeenCalledTimes(3);
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).not.toBe(firstUuid);
  });

  it("uses one ingestion UUID across devices for the same identified user key", () => {
    const properties = {
      surface: "pricing_dialog",
      source: "plan_cards",
      from_tier: "free",
    };

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    const firstDeviceUuid = mockCapture.mock.calls[0]?.[2]?.uuid;

    // A different device has no access to the first device's local storage.
    window.localStorage.clear();

    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    const secondDeviceUuid = mockCapture.mock.calls[1]?.[2]?.uuid;

    expect(secondDeviceUuid).toBe(firstDeviceUuid);

    mockPostHog.get_distinct_id.mockReturnValue("user_456");
    window.localStorage.clear();
    expect(captureUpgradeCtaImpression(properties)).toBe(true);
    expect(mockCapture.mock.calls[2]?.[2]?.uuid).not.toBe(firstDeviceUuid);
  });
});
