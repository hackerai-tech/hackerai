import { ConvexError } from "convex/values";
import { getBranchErrorMessage } from "../branch-error";

describe("branch error guidance", () => {
  it("uses fixed guidance for the structured history guard without displaying server content", () => {
    const message = getBranchErrorMessage(
      new ConvexError({
        code: "BRANCH_HISTORY_TOO_LARGE",
        message: "private server details",
      }),
    );

    expect(message).toContain("Try branching from an earlier message.");
    expect(message).toContain("Your original task is unchanged.");
    expect(message).not.toContain("private server details");
    expect(message).not.toContain("Please try again.");
  });

  it.each([
    undefined,
    null,
    "BRANCH_HISTORY_TOO_LARGE",
    new Error("BRANCH_HISTORY_TOO_LARGE"),
    { data: { code: "BRANCH_HISTORY_TOO_LARGE" } },
    new ConvexError("BRANCH_HISTORY_TOO_LARGE"),
    new ConvexError(null),
    new ConvexError(["BRANCH_HISTORY_TOO_LARGE"]),
    new ConvexError({ code: "UNAUTHORIZED", message: "private details" }),
    new ConvexError({ code: "UNKNOWN", message: "BRANCH_HISTORY_TOO_LARGE" }),
  ])(
    "preserves the generic fallback for unrelated or malformed errors (%#)",
    (error) => {
      expect(getBranchErrorMessage(error)).toBe(
        "Failed to branch task. Please try again.",
      );
    },
  );
});
