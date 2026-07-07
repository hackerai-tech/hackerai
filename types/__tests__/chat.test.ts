import {
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

  it("downgrades Max to Pro outside Ultra", () => {
    expect(normalizeSelectedModelForSubscription("hackerai-max", "pro")).toBe(
      "hackerai-pro",
    );
    expect(
      normalizeSelectedModelForSubscription("hackerai-max", "pro-plus"),
    ).toBe("hackerai-pro");
    expect(normalizeSelectedModelForSubscription("hackerai-max", "team")).toBe(
      "hackerai-pro",
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

  it("preserves explicit paid overrides except Max outside Ultra", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "ultra"),
    ).toBe("hackerai-max");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "team"),
    ).toBe("hackerai-pro");
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-pro", "team"),
    ).toBe("hackerai-pro");
  });
});
