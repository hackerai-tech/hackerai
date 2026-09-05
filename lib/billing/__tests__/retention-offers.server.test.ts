import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";

const mockGetFlagValue = jest.fn();
const mockWarn = jest.fn();

jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagValueForUser: mockGetFlagValue,
  phLogger: { warn: mockWarn },
}));

describe("getPauseOfferFlagState", () => {
  const originalOverride = process.env.PAUSE_OFFER_ENABLED;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.PAUSE_OFFER_ENABLED;
  });

  afterEach(() => {
    if (originalOverride === undefined) delete process.env.PAUSE_OFFER_ENABLED;
    else process.env.PAUSE_OFFER_ENABLED = originalOverride;
  });

  it("maps flag values to enabled and disabled", async () => {
    const { getPauseOfferFlagState } =
      await import("../retention-offers.server");
    mockGetFlagValue.mockResolvedValueOnce(true as never);
    await expect(getPauseOfferFlagState("user_1")).resolves.toBe("enabled");
    mockGetFlagValue.mockResolvedValueOnce(false as never);
    await expect(getPauseOfferFlagState("user_1")).resolves.toBe("disabled");
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("retries once and reports an unavailable flag service", async () => {
    const { getPauseOfferFlagState, isPauseOfferEnabledForUser } =
      await import("../retention-offers.server");
    mockGetFlagValue
      .mockResolvedValueOnce(null as never)
      .mockResolvedValueOnce(true as never);
    await expect(getPauseOfferFlagState("user_1")).resolves.toBe("enabled");
    expect(mockGetFlagValue).toHaveBeenCalledTimes(2);

    mockGetFlagValue.mockResolvedValue(null as never);
    await expect(isPauseOfferEnabledForUser("user_1")).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(
      "retention_offer_flag_unavailable",
      expect.objectContaining({
        userId: "user_1",
        flag_key: "hac-96-pause-subscription-offer",
      }),
    );
  });

  it("honours the environment override without calling PostHog", async () => {
    process.env.PAUSE_OFFER_ENABLED = "false";
    const { getPauseOfferFlagState } =
      await import("../retention-offers.server");
    await expect(getPauseOfferFlagState("user_1")).resolves.toBe("disabled");
    expect(mockGetFlagValue).not.toHaveBeenCalled();
  });
});
