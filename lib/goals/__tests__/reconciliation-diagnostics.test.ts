import { ConvexError } from "convex/values";
import { classifyGoalReconciliationFailure } from "../reconciliation-diagnostics";

// Mirrors how ConvexHttpClient forwards structured server error data.
const convexFailure = (message: string, data: unknown) =>
  Object.assign(new ConvexError(message), { data });

describe("classifyGoalReconciliationFailure", () => {
  it.each([
    [
      "the fixed owned-chat rejection",
      convexFailure(
        "[Request ID: ABCDEF0123456789] Server Error PRIVATE_DETAIL",
        "Goal chat unavailable",
      ),
      "goal_chat_unavailable",
      "abcdef0123456789",
    ],
    [
      "a chat-history suspension",
      convexFailure("[Request ID: 0123456789abcdef] Server Error", {
        code: "CHAT_ACCESS_SUSPENDED",
        message: "PRIVATE_SUSPENSION_MESSAGE",
        suspensionCategory: "PRIVATE_CATEGORY",
      }),
      "chat_access_suspended",
      "0123456789abcdef",
    ],
    [
      "another structured Convex rejection",
      convexFailure("[Request ID: 0123456789abcdef] Server Error", {
        code: "PRIVATE_CODE",
      }),
      "convex_error",
      "0123456789abcdef",
    ],
    ["a transport failure", new TypeError("PRIVATE_URL"), "type_error", "none"],
    ["an ordinary error", new Error("PRIVATE_MESSAGE"), "other_error", "none"],
    ["a thrown string", "PRIVATE_STRING", "thrown_value", "none"],
    ["a thrown object", { data: "PRIVATE_DATA" }, "thrown_value", "none"],
  ])(
    "classifies %s by finite kind and exact request ID only",
    (_label, error, failureKind, convexRequestId) => {
      const result = classifyGoalReconciliationFailure(error);
      expect(result).toEqual({ failureKind, convexRequestId });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    },
  );

  it.each([
    "[Request ID: abcdef012345678] short",
    "[Request ID: abcdef01234567890] long",
    "[Request ID: PRIVATE_REQUEST] not hex",
    `[Request ID: abcdef0123456789] ${"x".repeat(4096)}`,
  ])("does not retain a malformed or oversized request ID: %s", (message) => {
    expect(
      classifyGoalReconciliationFailure(convexFailure(message, "x"))
        .convexRequestId,
    ).toBe("none");
  });

  it("does not evaluate accessors or inherited fields", () => {
    const getter = jest.fn(() => "Goal chat unavailable");
    const code = jest.fn(() => "CHAT_ACCESS_SUSPENDED");
    const accessor = new Error("[Request ID: abcdef0123456789]");
    Object.defineProperty(accessor, "data", { get: getter });
    const nested = convexFailure(
      "x",
      Object.defineProperty({}, "code", { get: code }),
    );
    const inherited = Object.assign(
      Object.create({ data: "Goal chat unavailable" }),
      { message: "[Request ID: abcdef0123456789]" },
    );
    const lazyMessage = new Error("x");
    Object.defineProperty(lazyMessage, "message", {
      get: () => "[Request ID: abcdef0123456789]",
    });
    expect(classifyGoalReconciliationFailure(accessor)).toEqual({
      failureKind: "other_error",
      convexRequestId: "abcdef0123456789",
    });
    expect(classifyGoalReconciliationFailure(nested).failureKind).toBe(
      "convex_error",
    );
    expect(classifyGoalReconciliationFailure(inherited)).toEqual({
      failureKind: "thrown_value",
      convexRequestId: "abcdef0123456789",
    });
    expect(classifyGoalReconciliationFailure(lazyMessage)).toEqual({
      failureKind: "other_error",
      convexRequestId: "none",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(code).not.toHaveBeenCalled();
  });

  it("returns a finite unreadable kind when inspection throws", () => {
    const hostile = new Proxy(new Error("PRIVATE_MESSAGE"), {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_TRAP");
      },
    });
    expect(classifyGoalReconciliationFailure(hostile)).toEqual({
      failureKind: "unreadable_error",
      convexRequestId: "none",
    });
  });
});
