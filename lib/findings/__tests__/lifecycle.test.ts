import {
  closeFindingInputSchema,
  FINDING_CLOSURE_CONTEXT_MAX,
} from "../lifecycle";

describe("finding lifecycle validation", () => {
  it.each(["already_fixed", "wont_fix", "false_positive"] as const)(
    "accepts the %s closure reason",
    (reason) => {
      expect(
        closeFindingInputSchema.parse({
          reason,
          context: "Confirmed in retest.",
        }),
      ).toEqual({ reason, context: "Confirmed in retest." });
    },
  );

  it("requires meaningful closure context", () => {
    expect(
      closeFindingInputSchema.safeParse({
        reason: "already_fixed",
        context: "   ",
      }).success,
    ).toBe(false);
  });

  it("bounds closure context", () => {
    expect(
      closeFindingInputSchema.safeParse({
        reason: "wont_fix",
        context: "x".repeat(FINDING_CLOSURE_CONTEXT_MAX + 1),
      }).success,
    ).toBe(false);
  });

  it("rejects unknown reasons and extra fields", () => {
    expect(
      closeFindingInputSchema.safeParse({
        reason: "resolved",
        context: "Done",
      }).success,
    ).toBe(false);
    expect(
      closeFindingInputSchema.safeParse({
        reason: "already_fixed",
        context: "Done",
        title: "Do not accept report content",
      }).success,
    ).toBe(false);
  });
});
