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
    expect(normalizeSelectedModelForSubscription(null, "ultra")).toBe("auto");
    expect(normalizeSelectedModelForSubscription(undefined, "team")).toBe(
      "auto",
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

  it("preserves explicit paid overrides", () => {
    expect(
      normalizeSelectedModelOverrideForSubscription("hackerai-max", "team"),
    ).toBe("hackerai-max");
  });
});
