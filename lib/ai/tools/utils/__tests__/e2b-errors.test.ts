// The SDK's template builder imports an ESM parser unused by error handling.
jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import {
  classifyE2BError,
  getUserFacingE2BErrorMessage,
  NotFoundError,
  TimeoutError,
} from "../e2b-errors";

describe("unavailable sandbox messages", () => {
  it.each([
    ["expired", new TimeoutError("sandbox timeout")],
    ["missing", new NotFoundError("Sandbox not found")],
  ])("does not promise a replacement for %s sandboxes", (_reason, error) => {
    // Reporting a permanent connect failure does not create a replacement.
    expect(classifyE2BError(error)).toBe("permanent");
    expect(getUserFacingE2BErrorMessage(error)).toMatch(/expired/i);
    expect(getUserFacingE2BErrorMessage(error)).not.toMatch(
      /will be created automatically/i,
    );
  });
});
