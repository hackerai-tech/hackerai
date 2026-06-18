import { isExpectedAlreadyGoneCleanupError } from "../cleanup-errors";

describe("isExpectedAlreadyGoneCleanupError", () => {
  it("matches nested process and sandbox terminal-state errors", () => {
    expect(
      isExpectedAlreadyGoneCleanupError({
        message: "cleanup failed",
        cause: Object.assign(new Error("no such process"), { code: "ESRCH" }),
      }),
    ).toBe(true);

    expect(
      isExpectedAlreadyGoneCleanupError({
        name: "NotFoundError",
        status: 404,
        responseBody: "sandbox not_found",
      }),
    ).toBe(true);
  });

  it("matches already closed transport cleanup races", () => {
    expect(
      isExpectedAlreadyGoneCleanupError(
        new Error("WebSocket channel already closed"),
      ),
    ).toBe(true);
  });

  it("does not match permission, auth, or generic network errors", () => {
    expect(
      isExpectedAlreadyGoneCleanupError(new Error("permission denied")),
    ).toBe(false);
    expect(isExpectedAlreadyGoneCleanupError(new Error("unauthorized"))).toBe(
      false,
    );
    expect(
      isExpectedAlreadyGoneCleanupError(new Error("network timeout")),
    ).toBe(false);
  });
});
