import {
  getLocalStopDiagnostic,
  LocalConnectionLostError,
  localStopAnalyticsProperties,
} from "../local-connection-stop";

const CONNECTION = "6f1c2d3e-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

it("keeps the legacy constructor's fixed user-facing error and an unavailable cause", () => {
  const error = new LocalConnectionLostError();
  expect(error).toBeInstanceOf(Error);
  expect(error.name).toBe("LocalConnectionLostError");
  expect(error.message).toBe(
    "The local connection was lost. Reconnect your computer, then resume from the chat.",
  );
  expect(error.stopReason).toBe("unavailable");
  expect(localStopAnalyticsProperties(error)).toEqual({
    local_stop_diagnostic_version: 1,
    local_stop_reason: "unavailable",
  });
  // Diagnostics are not own enumerable fields that error loggers serialize.
  expect(Object.keys(error)).toEqual(["name"]);
});

it("projects only validated closed fields", () => {
  const error = new LocalConnectionLostError("observer_reconnecting", {
    connectionId: CONNECTION,
    hadPositivePresence: true,
    lastPositivePresenceAgeMs: 4_999.6,
    callbackCode: 3012,
    clientState: "connecting",
    // Raw SDK context must never be carried along.
    ...({ reason: "PRIVATE", message: "PRIVATE", channel: "PRIVATE" } as {}),
  });
  expect(error.message).toBe(new LocalConnectionLostError().message);
  expect(localStopAnalyticsProperties(error)).toEqual({
    local_stop_diagnostic_version: 1,
    local_stop_reason: "observer_reconnecting",
    local_stop_connection_id: CONNECTION,
    local_stop_had_positive_presence: true,
    local_stop_last_positive_presence_age_ms: 5_000,
    local_stop_callback_code: 3012,
    local_stop_client_state: "connecting",
  });
  expect(JSON.stringify(getLocalStopDiagnostic(error))).not.toContain(
    "PRIVATE",
  );
});

it.each([
  [0, "connected"],
  [4_999, "disconnected"],
] as const)(
  "keeps callback code %s and client state %s",
  (callbackCode, clientState) => {
    expect(
      localStopAnalyticsProperties(
        new LocalConnectionLostError("subscription_reconnecting", {
          callbackCode,
          clientState,
        }),
      ),
    ).toMatchObject({
      local_stop_callback_code: callbackCode,
      local_stop_client_state: clientState,
    });
  },
);

it.each([
  ["fraction", 1.5, "CONNECTED"],
  ["NaN", NaN, "closed"],
  ["infinite", Infinity, "PRIVATE state"],
  ["above 4999", 5_000, 1],
  ["unsafe overflow", 2 ** 53, {}],
  ["negative", -1, ["connected"]],
  ["string", "1", new String("connected")],
  ["boxed", new Number(1), undefined],
])(
  "omits an invalid callback code and client state: %s",
  (_name, callbackCode, clientState) => {
    const properties = localStopAnalyticsProperties(
      new LocalConnectionLostError("subscription_reconnecting", {
        callbackCode,
        clientState,
      } as never),
    );
    expect(properties).toEqual({
      local_stop_diagnostic_version: 1,
      local_stop_reason: "subscription_reconnecting",
    });
  },
);

it.each([
  [
    "non-UUID connection and unknown reason",
    "PRIVATE reason",
    { connectionId: "PRIVATE-host" },
  ],
  [
    "negative age",
    "presence_timeout",
    { hadPositivePresence: true, lastPositivePresenceAgeMs: -1 },
  ],
  [
    "non-finite age",
    "presence_timeout",
    { hadPositivePresence: true, lastPositivePresenceAgeMs: Infinity },
  ],
  [
    "age above one day",
    "presence_timeout",
    { hadPositivePresence: true, lastPositivePresenceAgeMs: 86_400_001 },
  ],
  [
    "age without a positive observation",
    "setup_timeout",
    { hadPositivePresence: false, lastPositivePresenceAgeMs: 10 },
  ],
])("omits invalid optional values: %s", (_name, reason, details) => {
  const properties = localStopAnalyticsProperties(
    new LocalConnectionLostError(reason as never, details as never),
  );
  expect(properties).not.toHaveProperty("local_stop_connection_id");
  expect(properties).not.toHaveProperty(
    "local_stop_last_positive_presence_age_ms",
  );
  expect(JSON.stringify(properties)).not.toContain("PRIVATE");
  if (reason === "PRIVATE reason")
    expect(properties?.local_stop_reason).toBe("unavailable");
});

it("never invokes getters or proxy traps that could expose private values", () => {
  const read = jest.fn(() => "PRIVATE");
  const getterDetails = Object.defineProperties(
    {},
    Object.fromEntries(
      ["connectionId", "callbackCode", "clientState"].map((key) => [
        key,
        { enumerable: true, get: read },
      ]),
    ),
  );
  const throwingProxy = new Proxy(
    {},
    {
      getOwnPropertyDescriptor: () => {
        throw new Error("PRIVATE trap");
      },
    },
  );
  for (const details of [getterDetails, throwingProxy]) {
    const error = new LocalConnectionLostError(
      "selected_host_left",
      details as never,
    );
    expect(localStopAnalyticsProperties(error)).toEqual({
      local_stop_diagnostic_version: 1,
      local_stop_reason: "selected_host_left",
    });
  }
  expect(read).not.toHaveBeenCalled();
});

it("ignores forged errors that were not produced by the constructor", () => {
  const trap = jest.fn();
  const forged = [
    Object.create(LocalConnectionLostError.prototype),
    { local_stop_reason: "selected_host_left", reason: "selected_host_left" },
    new Proxy(new LocalConnectionLostError("selected_host_left"), {
      get: trap,
      getPrototypeOf: trap,
    }),
    "selected_host_left",
    null,
  ];
  for (const value of forged) {
    expect(getLocalStopDiagnostic(value)).toBeUndefined();
    expect(localStopAnalyticsProperties(value)).toBeUndefined();
  }
  expect(trap).not.toHaveBeenCalled();
});
