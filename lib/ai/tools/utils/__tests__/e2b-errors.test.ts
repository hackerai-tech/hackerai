// The SDK's template builder imports an ESM parser unused by error handling.
jest.mock("dockerfile-ast", () => ({}), { virtual: true });

import {
  classifyE2BError,
  getUserFacingE2BErrorMessage,
  getE2BErrorKind,
  getE2BConnectConflictMessageSignal,
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

describe("connect conflict message signal", () => {
  const CLOSED_SIGNALS = [
    "resuming",
    "pausing",
    "killing",
    "snapshotting",
    "already_running",
    "guest_agent_unresponsive",
    "busy",
    "none",
    "multiple",
    "unreadable",
    "oversized",
  ];
  // Mirrors the SDK: `${status}: ${body message}` with a numeric statusCode.
  const conflict = (message: string) =>
    Object.assign(new SandboxError(`409: ${message}`), { statusCode: 409 });

  it.each([
    ['Sandbox "i8k2private" is being killed', "killing"],
    ['Sandbox "i8k2private" is being paused', "pausing"],
    ['Sandbox "i8k2private" is being snapshotted', "snapshotting"],
    [
      "Sandbox snapshot is currently being created for sandbox 'i8k2private'",
      "snapshotting",
    ],
    ['Sandbox "i8k2private" is in resuming state', "resuming"],
    ['Sandbox "i8k2private" is in pausing state', "pausing"],
    ["Sandbox i8k2private is already running", "already_running"],
    [
      'Sandbox "i8k2private" is busy with another operation, please retry later',
      "busy",
    ],
    // The phrase outranks "resuming" mentioned later in the same refusal.
    [
      "Sandbox 'i8k2private' cannot be resumed with its memory: its snapshot was taken while the sandbox guest agent was not responding, and resuming the memory would bring that back.",
      "guest_agent_unresponsive",
    ],
    ["SANDBOX IS BEING PAUSED", "pausing"],
    ["Conflict", "none"],
    ["", "none"],
    ["[object Object]", "none"],
  ])("projects %p to %p", (message, expected) => {
    expect(getE2BConnectConflictMessageSignal(conflict(message))).toBe(
      expected,
    );
  });

  it.each([
    "unpausing",
    "pausings",
    "prekilling the sandbox",
    "resuming_job",
    "snapshotting2",
    "already-running",
    "already runningly",
    "being pausedx",
    "Sandbox is busy",
    "paused",
    "killed",
    "the guest agent responded",
  ])(
    "ignores lifecycle text inside longer tokens or loose words: %p",
    (text) => {
      expect(getE2BConnectConflictMessageSignal(conflict(text))).toBe("none");
    },
  );

  it("ignores lifecycle words inside hyphenated identifier tokens", () => {
    expect(
      getE2BConnectConflictMessageSignal(
        conflict('Sandbox "pausing-resuming" is being killed'),
      ),
    ).toBe("killing");
    expect(
      getE2BConnectConflictMessageSignal(
        conflict('Sandbox "pausing-resuming" is in a conflicting state'),
      ),
    ).toBe("none");
  });

  it.each([
    ["is being paused; also busy with another operation", "multiple"],
    ["pausing then killing", "multiple"],
    ["is being paused, is being paused", "pausing"],
    ["is being paused while pausing", "pausing"],
  ])("reports distinct signals as multiple: %p", (message, expected) => {
    expect(getE2BConnectConflictMessageSignal(conflict(message))).toBe(
      expected,
    );
  });

  it("returns only a closed signal, never private message text", () => {
    const sentinel = "private-sentinel-token-7f3a";
    for (const message of [
      sentinel,
      `${sentinel} is being paused`,
      `multiple ${sentinel}`,
      "oversized",
      "unreadable",
    ]) {
      const signal = getE2BConnectConflictMessageSignal(conflict(message));
      expect(CLOSED_SIGNALS).toContain(signal);
      expect(String(signal)).not.toContain(sentinel);
    }
    // A message that merely spells a closed value is not that classification.
    expect(getE2BConnectConflictMessageSignal(conflict("multiple"))).toBe(
      "none",
    );
  });

  it("inspects at most 4096 message characters", () => {
    const atLimit = conflict("x");
    atLimit.message = `${"x".repeat(4096 - "is being paused".length - 1)} is being paused`;
    expect(atLimit.message).toHaveLength(4096);
    expect(getE2BConnectConflictMessageSignal(atLimit)).toBe("pausing");
    const overLimit = conflict("x");
    overLimit.message = `${atLimit.message}x`;
    expect(getE2BConnectConflictMessageSignal(overLimit)).toBe("oversized");
  });

  it("reports an inaccessible or non-string message as unreadable", () => {
    const throwing = conflict("is being paused");
    Object.defineProperty(throwing, "message", {
      get() {
        throw new Error("private read");
      },
    });
    const nonString = conflict("x");
    Object.defineProperty(nonString, "message", {
      value: { toString: () => "is being paused" },
    });
    const proxied = new Proxy(conflict("is being paused"), {
      get(target, key, receiver) {
        if (key === "message") throw new Error("private read");
        return Reflect.get(target, key, receiver);
      },
    });
    for (const error of [throwing, nonString, proxied])
      expect(getE2BConnectConflictMessageSignal(error)).toBe("unreadable");
  });

  it("ignores other errors without reading their message", () => {
    const readMessage = jest.fn(() => "is being paused");
    const withMessage = <T extends object>(error: T) =>
      Object.defineProperty(error, "message", { get: readMessage });
    const throwingStatus = withMessage(new SandboxError("x"));
    Object.defineProperty(throwingStatus, "statusCode", {
      get() {
        throw new Error("private read");
      },
    });
    for (const error of [
      withMessage(Object.assign(new SandboxError("x"), { statusCode: 504 })),
      withMessage(Object.assign(new SandboxError("x"), { statusCode: "409" })),
      withMessage(new SandboxError("x")),
      withMessage(Object.assign(new Error("x"), { statusCode: 409 })),
      withMessage({ statusCode: 409 }),
      throwingStatus,
      new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error("private prototype");
          },
        },
      ),
      null,
      "409: is being paused",
    ])
      expect(getE2BConnectConflictMessageSignal(error)).toBeUndefined();
    expect(readMessage).not.toHaveBeenCalled();
  });
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
