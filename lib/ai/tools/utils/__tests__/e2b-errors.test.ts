// The SDK's template builder imports an ESM parser unused by error handling.
jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import {
  classifyE2BError,
  getUserFacingE2BErrorMessage,
  getE2BErrorKind,
  AuthenticationError,
  TemplateError,
  InvalidArgumentError,
  SandboxError,
  NotFoundError,
  TimeoutError,
} from "../e2b-errors";

it.each([
  [new NotFoundError("private provider body"), "not_found"],
  [new AuthenticationError("private provider body"), "authentication"],
  [new TemplateError("private provider body"), "template"],
  [new InvalidArgumentError("private provider body"), "invalid_argument"],
  [new TimeoutError("private provider body"), "timeout"],
  [new SandboxError("private provider body"), "sandbox"],
  [
    Object.assign(new Error("private provider body"), {
      name: "NotFoundError",
    }),
    "other_error",
  ],
  [
    { name: "AuthenticationError", message: "private provider body" },
    "non_error",
  ],
])(
  "retains a closed SDK error identity without trusting public names (%#)",
  (error, expected) => {
    expect(getE2BErrorKind(error)).toBe(expected);
  },
);

it("does not read hostile diagnostic properties", () => {
  const error = new Error("private");
  Object.defineProperty(error, "name", {
    get() {
      throw new Error("private read");
    },
  });
  Object.defineProperty(error, "message", {
    get() {
      throw new Error("private read");
    },
  });
  expect(getE2BErrorKind(error)).toBe("other_error");
  expect(
    getE2BErrorKind(
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("private prototype");
          },
        },
      ),
    ),
  ).toBe("unreadable");
});

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
