import {
  CANCELLATION_REASON_DETAILS_MAX_LENGTH,
  getCancellationReasonSubcategoryOptions,
  isCancellationReasonCategory,
  isCancellationReasonSubcategory,
  isCancellationReasonSubcategoryForCategory,
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

  it("returns only relevant structured follow-ups", () => {
    expect(
      getCancellationReasonSubcategoryOptions("missing_feature").map(
        ({ value }) => value,
      ),
    ).toEqual(["missing_capability", "wrong_execution_environment", "other"]);
    expect(
      isCancellationReasonSubcategoryForCategory(
        "missing_feature",
        "missing_capability",
      ),
    ).toBe(true);
    expect(
      isCancellationReasonSubcategoryForCategory(
        "missing_feature",
        "billing_or_renewal",
      ),
    ).toBe(false);
    expect(isCancellationReasonSubcategory("model_quality")).toBe(true);
    expect(isCancellationReasonSubcategory("generic_problem")).toBe(false);
  });

  it("caps written details before storage", () => {
    const oversized = "x".repeat(CANCELLATION_REASON_DETAILS_MAX_LENGTH + 10);
    expect(normalizeCancellationReasonDetails(oversized)).toHaveLength(
      CANCELLATION_REASON_DETAILS_MAX_LENGTH,
    );
  });
});
