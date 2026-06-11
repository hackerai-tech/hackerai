import {
  CANCELLATION_REASON_DETAILS_MAX_LENGTH,
  isCancellationReasonCategory,
  normalizeCancellationReasonDetails,
} from "../cancellation-reasons";

describe("cancellation reason helpers", () => {
  it("recognizes only supported reason categories", () => {
    expect(isCancellationReasonCategory("too_expensive")).toBe(true);
    expect(isCancellationReasonCategory("temporary_pause")).toBe(true);
    expect(isCancellationReasonCategory("")).toBe(false);
    expect(isCancellationReasonCategory("too expensive")).toBe(false);
  });

  it("requires written details", () => {
    expect(normalizeCancellationReasonDetails("  too pricey for now  ")).toBe(
      "too pricey for now",
    );
    expect(normalizeCancellationReasonDetails("   ")).toBeNull();
    expect(normalizeCancellationReasonDetails(undefined)).toBeNull();
  });

  it("caps written details before storage", () => {
    const oversized = "x".repeat(CANCELLATION_REASON_DETAILS_MAX_LENGTH + 10);
    expect(normalizeCancellationReasonDetails(oversized)).toHaveLength(
      CANCELLATION_REASON_DETAILS_MAX_LENGTH,
    );
  });
});
