import {
  getLocalStopDiagnostic,
  LocalConnectionLostError,
  localRecoveryAnalyticsProperties,
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
    socketCloseCode: 1006,
    socketCloseWasClean: false,
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
    local_stop_socket_close_code: 1006,
    local_stop_socket_close_was_clean: false,
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
  [1_000, true],
  [4_999, false],
] as const)(
  "keeps native close code %s with wasClean %s",
  (socketCloseCode, socketCloseWasClean) => {
    expect(
      localStopAnalyticsProperties(
        new LocalConnectionLostError("subscription_reconnecting", {
          socketCloseCode,
          socketCloseWasClean,
        }),
      ),
    ).toMatchObject({
      local_stop_socket_close_code: socketCloseCode,
      local_stop_socket_close_was_clean: socketCloseWasClean,
    });
  },
);

// The pair is kept whole or not at all; a partial pair cannot be interpreted.
it.each([
  ["below 1000", 999, true],
  ["above 4999", 5_000, false],
  ["fraction", 1_006.5, false],
  ["NaN", NaN, false],
  ["string code", "1006", false],
  ["boxed code", new Number(1006), false],
  ["string wasClean", 1_006, "false"],
  ["boxed wasClean", 1_006, new Boolean(false)],
  ["numeric wasClean", 1_006, 0],
  ["code only", 1_006, undefined],
  ["wasClean only", undefined, true],
])(
  "omits an invalid native close pair: %s",
  (_name, socketCloseCode, socketCloseWasClean) => {
    expect(
      localStopAnalyticsProperties(
        new LocalConnectionLostError("subscription_reconnecting", {
          callbackCode: 1,
          socketCloseCode,
          socketCloseWasClean,
        } as never),
      ),
    ).toEqual({
      local_stop_diagnostic_version: 1,
      local_stop_reason: "subscription_reconnecting",
      local_stop_callback_code: 1,
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
      [
        "connectionId",
        "callbackCode",
        "clientState",
        "socketCloseCode",
        "socketCloseWasClean",
      ].map((key) => [key, { enumerable: true, get: read }]),
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

describe("recovery outcome analytics", () => {
  const stopIn = (
    reason: "selected_host_recovery_expired" | "desktop_session_replaced",
    elapsed: number,
  ) =>
    new LocalConnectionLostError(reason, {
      connectionId: CONNECTION,
      recoveryWindowMs: 120_000,
      recoveryElapsedMs: elapsed,
    });

  it("projects the window and a coarse outage bucket for a stop during recovery", () => {
    expect(
      localStopAnalyticsProperties(
        stopIn("selected_host_recovery_expired", 120_004),
      ),
    ).toMatchObject({
      local_stop_recovery_window_ms: 120_000,
      local_stop_recovery_outage_bucket: "gte_120s",
    });
    expect(
      localStopAnalyticsProperties(stopIn("desktop_session_replaced", 42_000)),
    ).toMatchObject({ local_stop_recovery_outage_bucket: "30s_60s" });
  });

  it.each([
    [
      "an expired window",
      stopIn("selected_host_recovery_expired", 120_000),
      undefined,
      { local_recovery_outcome: "expired", local_recovered_outages: 0 },
    ],
    [
      "a stop inside the window",
      stopIn("desktop_session_replaced", 9_000),
      { recoveredOutages: 2, maxRecoveredOutageMs: 3_000 },
      {
        local_recovery_outcome: "stopped_in_window",
        local_recovered_outages: 2,
        local_recovered_max_outage_bucket: "lt_5s",
      },
    ],
    [
      "a departure that never entered a window",
      new LocalConnectionLostError("selected_host_left", {}),
      undefined,
      {
        local_recovery_outcome: "stopped_unrecoverable",
        local_recovered_outages: 0,
      },
    ],
    [
      "a run that recovered and finished",
      undefined,
      { recoveredOutages: 1, maxRecoveredOutageMs: 75_000 },
      {
        local_recovery_outcome: "recovered",
        local_recovered_outages: 1,
        local_recovered_max_outage_bucket: "60s_120s",
      },
    ],
  ])("classifies %s", (_name, stop, summary, expected) => {
    expect(localRecoveryAnalyticsProperties(summary, stop)).toEqual(expected);
  });

  it("reports nothing for a run without an outage or a local stop", () => {
    expect(
      localRecoveryAnalyticsProperties({ recoveredOutages: 0 }, undefined),
    ).toBeUndefined();
  });
});

describe("unreconciled operation analytics", () => {
  it("projects which closed cause fired, for which operation, and in which verification phase", () => {
    const stop = new LocalConnectionLostError("desktop_command_unreconciled", {
      connectionId: CONNECTION,
      recoveryPhase: "completion_check",
      unreconciledCause: "kill_unconfirmed",
      unreconciledOperation: "pty",
    });
    expect(localStopAnalyticsProperties(stop)).toEqual({
      local_stop_diagnostic_version: 1,
      local_stop_reason: "desktop_command_unreconciled",
      local_stop_connection_id: CONNECTION,
      local_stop_recovery_phase: "completion_check",
      local_stop_unreconciled_cause: "kill_unconfirmed",
      local_stop_unreconciled_operation: "pty",
    });
    // An end-of-response check is not an outage the run was recovering from.
    expect(localRecoveryAnalyticsProperties(undefined, stop)).toMatchObject({
      local_recovery_outcome: "stopped_unrecoverable",
    });
  });

  it("drops open values and a cause attached to any other stop", () => {
    const forgedCause = new LocalConnectionLostError(
      "desktop_command_unreconciled",
      {
        recoveryPhase: "PRIVATE" as never,
        unreconciledCause: "rm -rf /" as never,
        unreconciledOperation: "PRIVATE" as never,
      },
    );
    expect(getLocalStopDiagnostic(forgedCause)).toEqual({
      reason: "desktop_command_unreconciled",
    });
    const otherStop = new LocalConnectionLostError("selected_host_left", {
      unreconciledCause: "receiver_deadline",
      unreconciledOperation: "command",
    });
    expect(getLocalStopDiagnostic(otherStop)).toEqual({
      reason: "selected_host_left",
    });
  });

  it("counts operations a run continued past, even without an outage or a stop", () => {
    expect(
      localRecoveryAnalyticsProperties(
        { recoveredOutages: 0, unknownOutcomeOperations: 2 },
        undefined,
      ),
    ).toEqual({ local_unknown_outcome_operations: 2 });
    expect(
      localRecoveryAnalyticsProperties(
        {
          recoveredOutages: 1,
          maxRecoveredOutageMs: 2_000,
          unknownOutcomeOperations: 1,
        },
        undefined,
      ),
    ).toEqual({
      local_recovery_outcome: "recovered",
      local_recovered_outages: 1,
      local_recovered_max_outage_bucket: "lt_5s",
      local_unknown_outcome_operations: 1,
    });
  });
});
