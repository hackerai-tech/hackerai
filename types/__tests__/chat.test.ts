import {
  canUseExtraUsage,
  canUseMaxModel,
  normalizeMaxModelForSubscription,
  normalizeSelectedModelForSubscription,
  normalizeSelectedModelOverrideForSubscription,
} from "../chat";

describe("normalizeSelectedModelForSubscription", () => {
  it("forces free users to auto even when a paid model is stored", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-pro", "free")).toBe(
      "auto",
    );
    expect(normalizeSelectedModelForSubscription("hackerai-max", "free")).toBe(
      "auto",
    );
  });

  it("preserves paid users' selected model and defaults missing values to auto", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-pro", "pro")).toBe(
      "hackerai-pro",
    );
    expect(normalizeSelectedModelForSubscription("hackerai-max", "ultra")).toBe(
      "hackerai-max",
    );
    expect(normalizeSelectedModelForSubscription(null, "ultra")).toBe("auto");
    expect(normalizeSelectedModelForSubscription(undefined, "team")).toBe(
      "auto",
    );
  });

  it("preserves paid Max until entitlement-aware routing", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-max", "pro")).toBe(
      "hackerai-max",
    );
    expect(
      normalizeSelectedModelForSubscription("hackerai-max", "pro-plus"),
    ).toBe("hackerai-max");
    expect(normalizeSelectedModelForSubscription("hackerai-max", "team")).toBe(
      "hackerai-max",
    );
  });
});

describe("normalizeSelectedModelOverrideForSubscription", () => {
  it("forces free users to auto even when no override was sent", () => {
    expect(normalizeSelectedModelOverrideForSubscription(null, "free")).toBe(
      "auto",
    );
    expect(
      normalizeSelectedModelOverrideForSubscription(undefined, "free"),
    ).toBe("auto");
  });

  it("preserves missing paid overrides as undefined", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription(undefined, "pro"),
    ).toBeUndefined();
    expect(
      normalizeSelectedModelOverrideForSubscription(null, "ultra"),
    ).toBeUndefined();
  });

  it("preserves explicit paid overrides until entitlement-aware routing", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "ultra"),
    ).toBe("hackerai-max");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "team"),
    ).toBe("hackerai-max");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-pro", "team"),
    ).toBe("hackerai-pro");
  });
});

describe("Max model entitlement helpers", () => {
  it("allows Max for Ultra users", () => {
    expect(canUseMaxModel("ultra")).toBe(true);
  });

  it("allows Max for paid users with usable extra usage", () => {
    const extraUsageConfig = {
      enabled: true,
      hasBalance: true,
      balanceDollars: 10,
      autoReloadEnabled: false,
    };

    expect(canUseExtraUsage(extraUsageConfig)).toBe(true);
    expect(canUseMaxModel("pro", { extraUsageConfig })).toBe(true);
    expect(
      normalizeMaxModelForSubscription("hackerai-max", "pro", {
        extraUsageConfig,
      }),
    ).toBe("hackerai-max");
  });

  it("downgrades Max for paid users without usable extra usage", () => {
    expect(canUseMaxModel("pro")).toBe(false);
    expect(normalizeMaxModelForSubscription("hackerai-max", "pro")).toBe(
      "hackerai-pro",
    );
    expect(
      normalizeMaxModelForSubscription("hackerai-max", "pro-plus", {
        extraUsageConfig: {
          enabled: true,
          hasBalance: true,
          balanceDollars: 10,
          autoReloadEnabled: false,
          monthlyRemainingDollars: 0,
        },
      }),
    ).toBe("hackerai-pro");
  });
});
