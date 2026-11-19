import { DesktopAckTelemetry } from "../desktop-ack";
import { sampleDiagnosticOperation } from "../diagnostic-sampling";
jest.mock("../diagnostic-sampling", () => ({
  sampleDiagnosticOperation: jest.fn(() => true),
}));
let telemetry: DesktopAckTelemetry;
const startDesktopAckTelemetry = (
  context: Parameters<DesktopAckTelemetry["start"]>[0],
) => telemetry.start(context);
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "../client";
import {
  AcknowledgedCommandOutput,
  type AcknowledgedCommandSettlement,
} from "@/lib/centrifugo/acknowledged-command-output";
import { sanitizeDesktopAckEvent } from "../desktop-ack-privacy";
import {
  applyDesktopRuntimeIdentity,
  startDesktopRuntimeIdentityLookup,
  withDesktopRuntimeIdentity,
} from "../desktop-runtime-identity";
import {
  NATIVE_AUTHORIZATION_CAUSE_PROPERTIES,
  NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES,
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  NATIVE_AUTHORIZATION_IO_PROPERTIES,
  NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES,
  NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES,
  NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES,
  type NativeAuthorizationCauseDiagnostic,
  type NativeAuthorizationConnectorDiagnostic,
  type NativeAuthorizationDiagnostic,
  type NativeAuthorizationIoDiagnostic,
  type NativeAuthorizationMitigationDiagnostic,
  type NativeAuthorizationResponseDiagnostic,
  type NativeAuthorizationResponseReadDiagnostic,
  type NativeAuthorizationResponseReadTimingDiagnostic,
  type NativeAuthorizationTransportDiagnostic,
} from "../native-authorization-diagnostics";
import {
  DESKTOP_TERMINAL_ERROR_PROPERTIES,
  type DesktopTerminalErrorDiagnostic,
} from "../desktop-terminal-error-diagnostics";
import {
  DESKTOP_INVOCATION_ADMISSION_PROPERTIES,
  DESKTOP_INVOCATION_REJECTION_PROPERTIES,
  DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES,
  DESKTOP_INVOCATION_UNKNOWN_PROPERTIES,
  DESKTOP_STREAM_FENCE_PROPERTIES,
  type DesktopInvocationAdmissionDiagnostic,
  type DesktopInvocationRejectionDiagnostic,
  type DesktopInvocationSpawnHintDiagnostic,
  type DesktopInvocationUnknownDiagnostic,
  type DesktopStreamFenceDiagnostic,
} from "../desktop-invocation-rejection-diagnostics";

jest.mock("../client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
  subscribeAuthenticatedAnalytics: jest.fn(() => () => {}),
}));
jest.mock("@tauri-apps/api/core", () => ({
  invoke: async (command: string) =>
    command === "plugin:app|version" ? "0.0.74" : undefined,
}));
const capture = jest.mocked(captureQueuedAuthenticatedEvent);
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
const result: AcknowledgedCommandSettlement & { terminalExitCode: number } = {
  outcome: "acknowledged",
  reason: "terminal_ack",
  observedFrames: 2,
  enqueuedFrames: 2,
  acknowledgedFrames: 2,
  publishAttempts: 3,
  replayAttempts: 1,
  publishFailures: 0,
  resumeRequests: 1,
  pendingFrames: 0,
  pendingBytes: 0,
  peakPendingBytes: 20,
  terminalType: "exit",
  terminalExitCode: 0,
  terminalAcknowledged: true,
  durationMs: 2000,
  oldestPendingAgeMs: null,
  lastAcknowledgementAgeMs: 0,
  publishInFlightAgeMs: null,
};
const originalCommit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
beforeEach(() => {
  jest.clearAllMocks();
  telemetry = new DesktopAckTelemetry();
  capture.mockReturnValue(true);
  jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
  identity.mockReturnValue("original-user");
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "a".repeat(40);
});
afterEach(() => {
  telemetry.dispose();
  jest.useRealTimers();
});
afterAll(() => {
  if (originalCommit === undefined)
    delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = originalCommit;
});

it("emits one start and final with explicit content-free properties and the loaded build", () => {
  const settle = startDesktopAckTelemetry({
    connectionId: "connection",
    commandId: "command",
    chatId: "chat",
    triggerRunId: "run",
    command: "PRIVATE",
  } as never);
  settle({ ...result, data: "PRIVATE", message: "PRIVATE" } as never);
  settle(result);
  expect(capture).toHaveBeenCalledTimes(2);
  expect(capture.mock.calls.map(([event]) => event.event)).toEqual([
    "desktop_ack_command_started",
    "desktop_ack_command_settled",
  ]);
  expect(capture.mock.calls[1][0]).toMatchObject({
    dedupeKey: JSON.stringify(["connection", "command"]),
    properties: {
      ...result,
      schemaVersion: 2,
      outputProtocol: "ack-v1",
      hackerai_frontend_build_commit: "a".repeat(40),
      triggerRunId: "run",
    },
  });
  expect(JSON.stringify(capture.mock.calls)).not.toContain("PRIVATE");
});
it("leaves the final missing when the signed-in identity changes", () => {
  const settle = startDesktopAckTelemetry({
    connectionId: "connection",
    commandId: "command",
  });
  identity.mockReturnValue("another-user");
  settle(result);
  expect(capture).toHaveBeenCalledTimes(1);
});
it("does not invent identification or a build commit", () => {
  identity.mockReturnValue(null);
  startDesktopAckTelemetry({ connectionId: null, commandId: "command" })(
    result,
  );
  expect(capture).not.toHaveBeenCalled();
  identity.mockReturnValue("original-user");
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "unverified";
  startDesktopAckTelemetry({
    connectionId: "connection",
    commandId: "command",
  })(result);
  expect(capture.mock.calls[1][0].properties).not.toHaveProperty(
    "hackerai_frontend_build_commit",
  );
});
it("contains analytics capture errors", () => {
  capture.mockImplementation(() => {
    throw new Error("analytics unavailable");
  });
  expect(() =>
    startDesktopAckTelemetry({
      connectionId: "connection",
      commandId: "command",
    })(result),
  ).not.toThrow();
});

it("attributes only stopped output, preserving an unknown source on older callers", () => {
  capture.mockReset();
  for (const [reason, source, expected] of [
    ["stopped", "session_replaced", "session_replaced"],
    ["stopped", undefined, undefined],
    ["stopped", "PRIVATE", undefined],
    ["terminal_ack", "bridge_stop", undefined],
    ["canceled", "unauthenticated", undefined],
  ] as const) {
    const settle = startDesktopAckTelemetry({
      connectionId: "connection",
      commandId: `command-${capture.mock.calls.length}`,
    });
    settle(
      {
        ...result,
        reason,
        outcome:
          reason === "stopped"
            ? "incomplete"
            : reason === "canceled"
              ? "canceled"
              : "acknowledged",
      },
      source as never,
    );
    const properties = capture.mock.calls.at(-1)![0].properties;
    if (expected) expect(properties).toHaveProperty("stopSource", expected);
    else expect(properties).not.toHaveProperty("stopSource");
  }
  expect(JSON.stringify(capture.mock.calls)).not.toContain("PRIVATE");
});

it.each(["acknowledged", "canceled"] as const)(
  "does not attribute a contradictory %s stopped result before SDK sanitization",
  (outcome) => {
    capture.mockReset();
    startDesktopAckTelemetry({
      connectionId: "connection",
      commandId: "command",
    })({ ...result, outcome, reason: "stopped" }, "bridge_stop");
    expect(capture.mock.calls.at(-1)![0].properties).not.toHaveProperty(
      "stopSource",
    );
  },
);

it.each(["bridge_stop", "session_replaced", "PRIVATE", null, {}])(
  "filters an enriched stop source after SDK registration: %p",
  (stopSource) => {
    const sanitized = sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: {
        reason: "stopped",
        outcome: "incomplete",
        stopSource,
        command: "PRIVATE",
        $current_url: "PRIVATE",
      },
      $set: { content: "PRIVATE" },
    });
    expect(sanitized.properties).toEqual(
      stopSource === "bridge_stop" || stopSource === "session_replaced"
        ? { reason: "stopped", outcome: "incomplete", stopSource }
        : { reason: "stopped", outcome: "incomplete" },
    );
    expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
    expect(
      sanitizeDesktopAckEvent({
        event: "desktop_ack_command_started",
        properties: { stopSource: "bridge_stop" },
      }).properties,
    ).toEqual({});
  },
);

it("does not let registered properties attribute a successful final to bridge shutdown", () => {
  expect(
    sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: {
        outcome: "acknowledged",
        reason: "terminal_ack",
        stopSource: "bridge_stop",
      },
    }).properties,
  ).toEqual({ outcome: "acknowledged", reason: "terminal_ack" });
});

describe.each([
  "oldestPendingAgeMs",
  "lastAcknowledgementAgeMs",
  "publishInFlightAgeMs",
])("bounded timing property %s", (key) => {
  it.each([null, 0, 1250, Number.MAX_SAFE_INTEGER])(
    "retains numeric/null evidence %p before capture and after SDK enrichment",
    (value) => {
      capture.mockReset();
      startDesktopAckTelemetry({
        connectionId: "connection",
        commandId: "command",
      })({ ...result, [key]: value });
      expect(capture.mock.calls.at(-1)![0].properties).toHaveProperty(
        key,
        value,
      );
      expect(
        sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: {
            [key]: value,
            command: "PRIVATE",
            $current_url: "PRIVATE",
          },
        }).properties,
      ).toEqual({ [key]: value });
    },
  );

  it.each([
    "PRIVATE",
    "1250",
    -1,
    0.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    undefined,
    {},
    [],
  ])(
    "drops non-age values %p before capture and after SDK enrichment",
    (value) => {
      capture.mockReset();
      startDesktopAckTelemetry({
        connectionId: "connection",
        commandId: "command",
      })({ ...result, [key]: value } as never);
      expect(capture.mock.calls.at(-1)![0].properties).not.toHaveProperty(key);
      expect(
        sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: { [key]: value },
        }).properties,
      ).toEqual({});
      expect(JSON.stringify(capture.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it("does not attach registered settlement timing to a start event", () => {
    expect(
      sanitizeDesktopAckEvent({
        event: "desktop_ack_command_started",
        properties: { [key]: 100 },
      }).properties,
    ).toEqual({});
  });
});

it("carries sender timing through authenticated capture and final SDK filtering without output", async () => {
  jest.useFakeTimers();
  capture.mockReset();
  try {
    const settle = startDesktopAckTelemetry({
      connectionId: "connection",
      commandId: "command",
    });
    const sender = new AcknowledgedCommandOutput(
      "command",
      Date.now() + 5000,
      () => new Promise(() => {}),
      () => true,
      settle,
    );
    sender.append({ type: "stdout", data: "PRIVATE OUTPUT" });
    await jest.advanceTimersByTimeAsync(1250);
    sender.stop();
    await expect(sender.delivered).rejects.toThrow("completion is unknown");
    expect(capture).toHaveBeenCalledTimes(2);
    const final = capture.mock.calls[1][0];
    const enriched = sanitizeDesktopAckEvent({
      event: final.event,
      properties: {
        ...final.properties,
        $current_url: "PRIVATE TARGET",
        command: "PRIVATE COMMAND",
      },
      $set: { target: "PRIVATE" },
    });
    expect(enriched.properties).toMatchObject({
      outcome: "incomplete",
      oldestPendingAgeMs: 1250,
      lastAcknowledgementAgeMs: null,
      publishInFlightAgeMs: 1250,
    });
    expect(JSON.stringify(enriched)).not.toContain("PRIVATE");
  } finally {
    jest.useRealTimers();
  }
});

describe("native authorization send receipt", () => {
  const group: NativeAuthorizationDiagnostic = {
    native_authorization_diagnostic_version: 1,
    native_authorization_send_timeout: false,
    native_authorization_send_connect: true,
    native_authorization_send_request: false,
    native_authorization_send_elapsed_ms: 42,
    native_authorization_origin_class: "canonical_production",
    native_app_version: "0.0.80",
    native_platform: "darwin",
  };
  const terminalError = {
    ...result,
    terminalType: "error" as const,
    terminalExitCode: null,
  };
  const nativeKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key),
    );
  const settle = (
    settlement: Record<string, unknown>,
    commandId = "authorization-failure",
  ) => {
    capture.mockClear();
    telemetry.start({ connectionId: "connection", commandId })(
      settlement as never,
    );
    return capture.mock.calls.find(
      ([event]) => event.event === "desktop_ack_command_settled",
    )?.[0];
  };
  const enrich = (properties: Record<string, unknown>) =>
    sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: {
        ...properties,
        $current_url: "PRIVATE URL",
        command: "PRIVATE COMMAND",
        message: "PRIVATE ERROR",
      },
      $set: { email: "PRIVATE" },
      $set_once: { email: "PRIVATE" },
    });

  it.each<Partial<NativeAuthorizationDiagnostic>>([
    {},
    {
      native_authorization_send_timeout: true,
      native_authorization_send_connect: true,
      native_authorization_send_request: true,
      native_authorization_send_elapsed_ms: 60_000,
    },
    {
      native_authorization_send_connect: false,
      native_authorization_send_elapsed_ms: 0,
      native_authorization_origin_class: "localhost",
    },
    { native_authorization_origin_class: "other_allowed" },
    { native_authorization_origin_class: "unknown" },
    { native_app_version: null, native_platform: null },
    { native_platform: "windows" },
  ])("keeps one coherent v1 group on a terminal-error final: %p", (change) => {
    const expected = { ...group, ...change };
    const final = settle({
      ...terminalError,
      nativeAuthorization: { ...expected, message: "PRIVATE" },
    });
    expect(final?.properties).toMatchObject({
      ...expected,
      terminalType: "error",
      telemetry_sample_rate: 1,
    });
    const enriched = enrich(final!.properties);
    expect(enriched.properties).toMatchObject(expected);
    expect(nativeKeys(enriched.properties)).toHaveLength(8);
    expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
  });

  it.each<[string, Record<string, unknown>]>([
    ["unsupported version", { native_authorization_diagnostic_version: 2 }],
    ["string version", { native_authorization_diagnostic_version: "1" }],
    ["missing version", { native_authorization_diagnostic_version: undefined }],
    ["string boolean", { native_authorization_send_timeout: "true" }],
    ["numeric boolean", { native_authorization_send_connect: 1 }],
    ["missing boolean", { native_authorization_send_request: undefined }],
    ["negative time", { native_authorization_send_elapsed_ms: -1 }],
    ["unbounded time", { native_authorization_send_elapsed_ms: 60_001 }],
    ["fractional time", { native_authorization_send_elapsed_ms: 0.5 }],
    ["NaN time", { native_authorization_send_elapsed_ms: NaN }],
    ["string time", { native_authorization_send_elapsed_ms: "42" }],
    ["hostname", { native_authorization_origin_class: "hackerai.co" }],
    ["private origin", { native_authorization_origin_class: "PRIVATE" }],
    ["private app version", { native_app_version: "PRIVATE" }],
    ["unknown app version", { native_app_version: "unknown" }],
    ["missing app version", { native_app_version: undefined }],
    ["unsupported platform", { native_platform: "macos" }],
    ["missing platform", { native_platform: undefined }],
  ])("drops every new field for %s", (_case, change) => {
    const invalid = { ...group, ...change };
    const final = settle({ ...terminalError, nativeAuthorization: invalid });
    expect(final?.properties).toMatchObject({ terminalType: "error" });
    expect(nativeKeys(final!.properties)).toEqual([]);
    const enriched = enrich({ terminalType: "error", ...invalid });
    expect(nativeKeys(enriched.properties)).toEqual([]);
    expect(enriched.properties).toEqual({ terminalType: "error" });
    expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
  });

  it("does not attach the group to non-error finals, starts or summaries", () => {
    const exitFinal = settle({
      ...result,
      terminalExitCode: 1,
      nativeAuthorization: group,
    });
    expect(exitFinal?.properties).toMatchObject({ terminalExitCode: 1 });
    expect(nativeKeys(exitFinal!.properties)).toEqual([]);
    for (const terminalType of ["exit", null, undefined])
      expect(nativeKeys(enrich({ terminalType, ...group }).properties)).toEqual(
        [],
      );
    for (const event of [
      "desktop_ack_command_started",
      "desktop_ack_delivery_summary",
    ])
      expect(
        sanitizeDesktopAckEvent({
          event,
          properties: { terminalType: "error", ...group },
        }).properties,
      ).toEqual(
        event === "desktop_ack_command_started"
          ? { terminalType: "error" }
          : {},
      );
  });

  it("does not let a registered app version stand in for a missing receipt", () => {
    expect(
      enrich({
        terminalType: "error",
        native_app_version: "0.0.80",
        native_platform: "darwin",
      }).properties,
    ).toEqual({ terminalType: "error" });
  });

  it("leaves sampling and routine suppression unchanged", () => {
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
    const routine = {
      ...result,
      replayAttempts: 0,
      resumeRequests: 0,
      nativeAuthorization: group,
    };
    expect(settle(routine, "routine")).toBeUndefined();
    expect(capture).not.toHaveBeenCalled();
    const final = settle({ ...terminalError, nativeAuthorization: group });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(final?.properties).toMatchObject({
      ...group,
      telemetry_sampled: false,
      telemetry_sample_rate: 1,
    });
  });

  describe("closed IO cause", () => {
    const cause: NativeAuthorizationCauseDiagnostic = {
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "connection_reset",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    };
    const causeKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
      );

    it.each<Partial<NativeAuthorizationCauseDiagnostic>>([
      {},
      { native_authorization_cause_io_kind: "unexpected_eof" },
      {
        native_authorization_cause_io_kind: "other",
        native_authorization_cause_source_depth: 8,
      },
      {
        native_authorization_cause_io_kind: "not_exposed",
        native_authorization_cause_source_depth: 0,
      },
      {
        native_authorization_cause_io_kind: "not_exposed",
        native_authorization_cause_source_depth: 8,
        native_authorization_cause_source_chain_truncated: true,
      },
    ])(
      "joins the cause to a valid v1 group on a terminal-error final: %p",
      (change) => {
        const expected = { ...cause, ...change };
        const final = settle({
          ...terminalError,
          nativeAuthorization: group,
          nativeAuthorizationCause: { ...expected, message: "PRIVATE" },
        });
        expect(final?.properties).toMatchObject({ ...group, ...expected });
        const enriched = enrich({
          ...final!.properties,
          native_authorization_cause_message: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({ ...group, ...expected });
        expect(causeKeys(enriched.properties)).toHaveLength(4);
        expect(nativeKeys(enriched.properties)).toHaveLength(8);
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it("never reports a cause without a valid v1 group", () => {
      for (const nativeAuthorization of [
        undefined,
        { ...group, native_authorization_send_elapsed_ms: 60_001 },
      ]) {
        const final = settle({
          ...terminalError,
          nativeAuthorization,
          nativeAuthorizationCause: cause,
        });
        expect(final?.properties).toMatchObject({ terminalType: "error" });
        expect(causeKeys(final!.properties)).toEqual([]);
        expect(nativeKeys(final!.properties)).toEqual([]);
        expect(
          causeKeys(
            enrich({ terminalType: "error", ...nativeAuthorization, ...cause })
              .properties,
          ),
        ).toEqual([]);
      }
      // Nor on a successful or nonzero exit, a start or a summary.
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorization: group,
        nativeAuthorizationCause: cause,
      });
      expect(causeKeys(exitFinal!.properties)).toEqual([]);
      expect(
        causeKeys(
          enrich({ terminalType: "exit", ...group, ...cause }).properties,
        ),
      ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          causeKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...group, ...cause },
            }).properties,
          ),
        ).toEqual([]);
    });

    it.each<[string, Record<string, unknown>]>([
      ["unsupported version", { native_authorization_cause_version: 2 }],
      ["string version", { native_authorization_cause_version: "1" }],
      ["missing version", { native_authorization_cause_version: undefined }],
      [
        "unlisted kind",
        { native_authorization_cause_io_kind: "connection_refused" },
      ],
      ["private kind", { native_authorization_cause_io_kind: "PRIVATE" }],
      ["missing kind", { native_authorization_cause_io_kind: undefined }],
      ["unbounded depth", { native_authorization_cause_source_depth: 9 }],
      ["negative depth", { native_authorization_cause_source_depth: -1 }],
      ["fractional depth", { native_authorization_cause_source_depth: 1.5 }],
      ["string depth", { native_authorization_cause_source_depth: "3" }],
      [
        "string truncation",
        { native_authorization_cause_source_chain_truncated: "false" },
      ],
      [
        "an exposed kind without a source link",
        { native_authorization_cause_source_depth: 0 },
      ],
      [
        "an exposed kind on a truncated walk",
        { native_authorization_cause_source_chain_truncated: true },
      ],
      [
        "a truncated walk shorter than the bound",
        {
          native_authorization_cause_io_kind: "not_exposed",
          native_authorization_cause_source_depth: 7,
          native_authorization_cause_source_chain_truncated: true,
        },
      ],
    ])("drops only the cause for %s", (_case, change) => {
      const invalid = { ...cause, ...change };
      const final = settle({
        ...terminalError,
        nativeAuthorization: group,
        nativeAuthorizationCause: invalid,
      });
      // The original v1 diagnostic is unaffected.
      expect(final?.properties).toMatchObject(group);
      expect(causeKeys(final!.properties)).toEqual([]);
      const enriched = enrich({ terminalType: "error", ...group, ...invalid });
      expect(enriched.properties).toEqual({ terminalType: "error", ...group });
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    let reads = 0;
    it.each<[string, () => unknown]>([
      // Valid on the first read, a canary afterwards.
      ["valid-looking", () => (reads++ === 0 ? "connection_reset" : "PRIVATE")],
      [
        "throwing",
        () => {
          reads++;
          throw new Error("PRIVATE");
        },
      ],
    ])(
      "never runs a %s cause getter at before_send and keeps the v1 group",
      (_case, get) => {
        reads = 0;
        const properties: Record<string, unknown> = {
          terminalType: "error",
          ...group,
          ...cause,
        };
        Object.defineProperty(
          properties,
          "native_authorization_cause_io_kind",
          { enumerable: true, get },
        );
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties,
        }).properties!;
        expect(reads).toBe(0);
        expect(causeKeys(sanitized)).toEqual([]);
        expect(sanitized).toEqual({ terminalType: "error", ...group });
        expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
      },
    );
  });

  describe("transport detail", () => {
    const cause: NativeAuthorizationCauseDiagnostic = {
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "other",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    };
    const transport: NativeAuthorizationTransportDiagnostic = {
      native_authorization_transport_version: 1,
      native_authorization_transport_io_kind_detail: "connection_refused",
      native_authorization_transport_native_tls_source: false,
      native_authorization_transport_source_depth: 3,
      native_authorization_transport_source_chain_truncated: false,
    };
    const transportKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key),
      );

    it.each<Partial<NativeAuthorizationTransportDiagnostic>>([
      {},
      // A typed TLS witness without any exposed IO error.
      {
        native_authorization_transport_io_kind_detail: "not_exposed",
        native_authorization_transport_native_tls_source: true,
        native_authorization_transport_source_depth: 2,
      },
      // The actual Other kind and the residual are distinct values.
      { native_authorization_transport_io_kind_detail: "other" },
      { native_authorization_transport_io_kind_detail: "unmapped" },
      { native_authorization_transport_io_kind_detail: "network_unreachable" },
      // Unlike the cause, an exposed kind may come from a truncated walk.
      {
        native_authorization_transport_io_kind_detail: "host_unreachable",
        native_authorization_transport_source_depth: 8,
        native_authorization_transport_source_chain_truncated: true,
      },
      {
        native_authorization_transport_io_kind_detail: "not_exposed",
        native_authorization_transport_source_depth: 0,
      },
    ])(
      "joins the detail to a valid v1 group on a terminal-error final: %p",
      (change) => {
        const expected = { ...transport, ...change };
        const final = settle({
          ...terminalError,
          nativeAuthorization: group,
          nativeAuthorizationCause: cause,
          nativeAuthorizationTransport: { ...expected, message: "PRIVATE" },
        });
        expect(final?.properties).toMatchObject({
          ...group,
          ...cause,
          ...expected,
        });
        const enriched = enrich({
          ...final!.properties,
          native_authorization_transport_message: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({
          ...group,
          ...cause,
          ...expected,
        });
        expect(transportKeys(enriched.properties)).toHaveLength(5);
        expect(nativeKeys(enriched.properties)).toHaveLength(8);
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it("never reports a detail without a valid v1 group", () => {
      for (const nativeAuthorization of [
        undefined,
        { ...group, native_authorization_origin_class: "hackerai.co" },
      ]) {
        const final = settle({
          ...terminalError,
          nativeAuthorization,
          nativeAuthorizationTransport: transport,
        });
        expect(final?.properties).toMatchObject({ terminalType: "error" });
        expect(transportKeys(final!.properties)).toEqual([]);
        expect(
          transportKeys(
            enrich({
              terminalType: "error",
              ...nativeAuthorization,
              ...transport,
            }).properties,
          ),
        ).toEqual([]);
      }
      // Nor on a successful or nonzero exit, a start or a summary.
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorization: group,
        nativeAuthorizationTransport: transport,
      });
      expect(transportKeys(exitFinal!.properties)).toEqual([]);
      expect(
        transportKeys(
          enrich({ terminalType: "exit", ...group, ...transport }).properties,
        ),
      ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          transportKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...group, ...transport },
            }).properties,
          ),
        ).toEqual([]);
    });

    it("leaves every existing group intact beside it", () => {
      const response: NativeAuthorizationResponseDiagnostic = {
        native_authorization_response_version: 1,
        native_authorization_response_http_status: 503,
        native_authorization_response_approval: "not_checked",
        native_authorization_response_origin_class: "canonical_production",
        native_authorization_response_platform: "windows",
        native_authorization_response_request_id_shape: "absent",
        native_authorization_response_request_id: null,
      };
      const mitigation: NativeAuthorizationMitigationDiagnostic = {
        native_authorization_response_mitigation_version: 1,
        native_authorization_response_mitigation: "absent",
      };
      const all = { ...group, ...cause, ...response, ...mitigation };
      for (const extra of [transport, {}]) {
        const sanitized = enrich({
          terminalType: "error",
          ...all,
          ...extra,
        }).properties;
        expect(sanitized).toEqual({ terminalType: "error", ...all, ...extra });
      }
    });

    it.each<[string, Record<string, unknown>]>([
      ["unsupported version", { native_authorization_transport_version: 2 }],
      ["string version", { native_authorization_transport_version: "1" }],
      [
        "missing version",
        { native_authorization_transport_version: undefined },
      ],
      [
        "a guessed TLS kind",
        { native_authorization_transport_io_kind_detail: "tls_handshake" },
      ],
      [
        "private kind",
        { native_authorization_transport_io_kind_detail: "PRIVATE" },
      ],
      [
        "missing kind",
        { native_authorization_transport_io_kind_detail: undefined },
      ],
      [
        "string TLS flag",
        { native_authorization_transport_native_tls_source: "false" },
      ],
      [
        "missing TLS flag",
        { native_authorization_transport_native_tls_source: undefined },
      ],
      ["unbounded depth", { native_authorization_transport_source_depth: 9 }],
      ["negative depth", { native_authorization_transport_source_depth: -1 }],
      [
        "fractional depth",
        { native_authorization_transport_source_depth: 1.5 },
      ],
      ["string depth", { native_authorization_transport_source_depth: "3" }],
      [
        "string truncation",
        { native_authorization_transport_source_chain_truncated: "false" },
      ],
      [
        "an exposed kind without a source link",
        { native_authorization_transport_source_depth: 0 },
      ],
      [
        "a TLS source without a source link",
        {
          native_authorization_transport_io_kind_detail: "not_exposed",
          native_authorization_transport_native_tls_source: true,
          native_authorization_transport_source_depth: 0,
        },
      ],
      [
        "a truncated walk shorter than the bound",
        {
          native_authorization_transport_source_depth: 7,
          native_authorization_transport_source_chain_truncated: true,
        },
      ],
    ])("drops only the detail for %s", (_case, change) => {
      const invalid = { ...transport, ...change };
      const final = settle({
        ...terminalError,
        nativeAuthorization: group,
        nativeAuthorizationCause: cause,
        nativeAuthorizationTransport: invalid,
      });
      // The original v1 and cause groups are unaffected.
      expect(final?.properties).toMatchObject({ ...group, ...cause });
      expect(transportKeys(final!.properties)).toEqual([]);
      const enriched = enrich({
        terminalType: "error",
        ...group,
        ...cause,
        ...invalid,
      });
      expect(enriched.properties).toEqual({
        terminalType: "error",
        ...group,
        ...cause,
      });
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    it("never runs a detail getter at before_send and keeps the v1 group", () => {
      let reads = 0;
      const properties: Record<string, unknown> = {
        terminalType: "error",
        ...group,
        ...transport,
      };
      Object.defineProperty(
        properties,
        "native_authorization_transport_native_tls_source",
        {
          enumerable: true,
          get() {
            reads++;
            throw new Error("PRIVATE");
          },
        },
      );
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties,
      }).properties!;
      expect(reads).toBe(0);
      expect(transportKeys(sanitized)).toEqual([]);
      expect(sanitized).toEqual({ terminalType: "error", ...group });
    });
  });

  describe("unmapped IO supplement", () => {
    const windows = { ...group, native_platform: "windows" as const };
    const cause: NativeAuthorizationCauseDiagnostic = {
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "other",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    };
    const transport: NativeAuthorizationTransportDiagnostic = {
      native_authorization_transport_version: 1,
      native_authorization_transport_io_kind_detail: "unmapped",
      native_authorization_transport_native_tls_source: false,
      native_authorization_transport_source_depth: 3,
      native_authorization_transport_source_chain_truncated: false,
    };
    const io: NativeAuthorizationIoDiagnostic = {
      native_authorization_io_version: 1,
      native_authorization_io_kind: "unknown",
      native_authorization_io_os_family: "winsock_host_not_found",
      native_authorization_io_source_depth: 3,
    };
    const ioKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_IO_PROPERTIES.has(key),
      );
    const causeKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CAUSE_PROPERTIES.has(key),
      );
    const transportKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES.has(key),
      );
    type Groups = {
      send?: unknown;
      cause?: unknown;
      transport?: unknown;
      io?: unknown;
    };
    const both = ({ send, cause, transport, io }: Groups) => ({
      final: settle({
        ...terminalError,
        nativeAuthorization: send,
        nativeAuthorizationCause: cause,
        nativeAuthorizationTransport: transport,
        nativeAuthorizationIo: io,
      }),
      enriched: enrich({
        terminalType: "error",
        ...(send as object),
        ...(cause as object),
        ...(transport as object),
        ...(io as object),
      }).properties!,
    });

    it.each(["linux", "PRIVATE"])(
      "copies the validated send snapshot without a second getter read (%s)",
      (laterPlatform) => {
        let reads = 0;
        const properties = {
          terminalType: "error",
          ...windows,
          ...cause,
          ...transport,
          ...io,
        };
        Object.defineProperty(properties, "native_platform", {
          enumerable: true,
          get() {
            return ++reads === 1 ? "windows" : laterPlatform;
          },
        });
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties,
        }).properties;
        expect(reads).toBe(1);
        expect(sanitized.native_platform).toBe("windows");
        expect(sanitized.native_authorization_io_os_family).toBe(
          "winsock_host_not_found",
        );
        expect(JSON.stringify(sanitized)).not.toContain("PRIVATE");
      },
    );

    it.each<[string, Groups]>([
      ["a Winsock family on Windows", { send: windows, io }],
      [
        "every named Winsock family",
        {
          send: windows,
          io: {
            ...io,
            native_authorization_io_os_family: "winsock_no_data",
            native_authorization_io_kind: "not_found",
          },
        },
      ],
      [
        "a Windows error without a stored code",
        {
          send: windows,
          io: { ...io, native_authorization_io_os_family: "no_raw_os_code" },
        },
      ],
      [
        "another Windows code",
        {
          send: windows,
          io: {
            ...io,
            native_authorization_io_os_family: "other_windows_os_code",
          },
        },
      ],
      [
        "another platform",
        {
          send: group,
          io: { ...io, native_authorization_io_os_family: "not_windows" },
        },
      ],
      [
        "a transport walk beyond the first IO error",
        {
          send: windows,
          transport: {
            ...transport,
            native_authorization_transport_source_depth: 8,
            native_authorization_transport_source_chain_truncated: true,
          },
        },
      ],
      [
        "the last observed link",
        {
          send: windows,
          cause: { ...cause, native_authorization_cause_source_depth: 8 },
          transport: {
            ...transport,
            native_authorization_transport_source_depth: 8,
          },
          io: { ...io, native_authorization_io_source_depth: 8 },
        },
      ],
      [
        "the first observed link",
        {
          send: windows,
          cause: { ...cause, native_authorization_cause_source_depth: 1 },
          transport: {
            ...transport,
            native_authorization_transport_source_depth: 1,
          },
          io: { ...io, native_authorization_io_source_depth: 1 },
        },
      ],
    ])("joins the same first IO error's supplement for %s", (_case, groups) => {
      const expected = {
        send: windows,
        cause,
        transport,
        io,
        ...groups,
      } as Required<Groups>;
      const { final, enriched } = both({
        ...expected,
        io: {
          ...(expected.io as object),
          message: "PRIVATE",
          rawOsError: "PRIVATE",
        },
      });
      const all = {
        ...(expected.send as object),
        ...(expected.cause as object),
        ...(expected.transport as object),
        ...(expected.io as object),
      };
      expect(final?.properties).toMatchObject(all);
      expect(enriched).toEqual({ terminalType: "error", ...all });
      for (const properties of [final!.properties!, enriched]) {
        expect(ioKeys(properties)).toHaveLength(4);
        expect(transportKeys(properties)).toHaveLength(5);
        expect(causeKeys(properties)).toHaveLength(4);
        expect(nativeKeys(properties)).toHaveLength(8);
      }
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    it.each<[string, Groups]>([
      [
        "an unknown platform",
        {
          send: { ...group, native_platform: null },
          io: { ...io, native_authorization_io_os_family: "not_windows" },
        },
      ],
      ["no v1 group", { send: undefined }],
      [
        "an invalid v1 group",
        { send: { ...windows, native_authorization_origin_class: "PRIVATE" } },
      ],
      ["no cause group", { cause: undefined }],
      ["no transport group", { transport: undefined }],
      [
        "a mapped transport kind",
        {
          transport: {
            ...transport,
            native_authorization_transport_io_kind_detail: "connection_refused",
          },
        },
      ],
      [
        "the actual Other kind",
        {
          transport: {
            ...transport,
            native_authorization_transport_io_kind_detail: "other",
          },
        },
      ],
      [
        "no exposed IO error",
        {
          cause: {
            ...cause,
            native_authorization_cause_io_kind: "not_exposed",
          },
          transport: {
            ...transport,
            native_authorization_transport_io_kind_detail: "not_exposed",
          },
        },
      ],
      [
        "a cause outside the Other fold",
        {
          cause: {
            ...cause,
            native_authorization_cause_io_kind: "connection_reset",
          },
        },
      ],
      [
        "a depth other than the cause's",
        { io: { ...io, native_authorization_io_source_depth: 2 } },
      ],
      [
        "a depth beyond the transport walk",
        {
          cause: { ...cause, native_authorization_cause_source_depth: 4 },
          io: { ...io, native_authorization_io_source_depth: 4 },
        },
      ],
      ["a Winsock family off Windows", { send: group }],
      [
        "a Winsock family on an unknown platform",
        { send: { ...group, native_platform: null } },
      ],
      [
        "a non-Windows family on Windows",
        { io: { ...io, native_authorization_io_os_family: "not_windows" } },
      ],
    ])("drops only the supplement for %s", (_case, groups) => {
      const given = { send: windows, cause, transport, io, ...groups };
      const { final, enriched } = both(given);
      for (const properties of [final!.properties!, enriched]) {
        expect(ioKeys(properties)).toEqual([]);
        expect(properties).toMatchObject({ terminalType: "error" });
      }
      // Every valid legacy group is unaffected by the dropped supplement.
      const kept = { ...given, io: undefined };
      expect(enriched).toEqual(both(kept).enriched);
      expect(final!.properties).toEqual(both(kept).final!.properties);
    });

    it.each<[string, Record<string, unknown>]>([
      ["unsupported version", { native_authorization_io_version: 2 }],
      ["string version", { native_authorization_io_version: "1" }],
      ["missing version", { native_authorization_io_version: undefined }],
      [
        "std's unstable kind name",
        { native_authorization_io_kind: "uncategorized" },
      ],
      [
        "an already mapped kind",
        { native_authorization_io_kind: "connection_refused" },
      ],
      ["private kind", { native_authorization_io_kind: "PRIVATE" }],
      ["missing kind", { native_authorization_io_kind: undefined }],
      ["a raw OS code", { native_authorization_io_os_family: 11001 }],
      [
        "a guessed family",
        { native_authorization_io_os_family: "dns_not_found" },
      ],
      ["private family", { native_authorization_io_os_family: "PRIVATE" }],
      ["no exposed depth", { native_authorization_io_source_depth: 0 }],
      ["unbounded depth", { native_authorization_io_source_depth: 9 }],
      ["fractional depth", { native_authorization_io_source_depth: 2.5 }],
      ["string depth", { native_authorization_io_source_depth: "3" }],
    ])("drops a malformed supplement with %s", (_case, change) => {
      const invalid = { ...io, ...change };
      const { final, enriched } = both({
        send: windows,
        cause,
        transport,
        io: invalid,
      });
      const kept = {
        terminalType: "error",
        ...windows,
        ...cause,
        ...transport,
      };
      expect(final?.properties).toMatchObject(kept);
      expect(ioKeys(final!.properties)).toEqual([]);
      expect(enriched).toEqual(kept);
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    it("never reports a supplement on other finals, starts or summaries", () => {
      const all = { ...windows, ...cause, ...transport, ...io };
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorization: windows,
        nativeAuthorizationCause: cause,
        nativeAuthorizationTransport: transport,
        nativeAuthorizationIo: io,
      });
      expect(ioKeys(exitFinal!.properties)).toEqual([]);
      expect(
        ioKeys(enrich({ terminalType: "exit", ...all }).properties),
      ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          ioKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...all },
            }).properties,
          ),
        ).toEqual([]);
    });

    it("never runs a supplement getter at before_send", () => {
      let reads = 0;
      const properties: Record<string, unknown> = {
        terminalType: "error",
        ...windows,
        ...cause,
        ...transport,
        ...io,
      };
      Object.defineProperty(properties, "native_authorization_io_os_family", {
        enumerable: true,
        get() {
          reads++;
          throw new Error("PRIVATE");
        },
      });
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties,
      }).properties!;
      expect(reads).toBe(0);
      expect(sanitized).toEqual({
        terminalType: "error",
        ...windows,
        ...cause,
        ...transport,
      });
    });
  });

  describe("connector phase snapshot", () => {
    const connector: NativeAuthorizationConnectorDiagnostic = {
      native_authorization_connector_version: 1,
      native_authorization_connector_phase: "connected",
      native_authorization_connector_attempts: 1,
      native_authorization_connector_elapsed_ms: 31,
    };
    const connectorKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_CONNECTOR_PROPERTIES.has(key),
      );

    it.each<Partial<NativeAuthorizationConnectorDiagnostic>>([
      {},
      {
        native_authorization_connector_phase: "pending",
        native_authorization_connector_elapsed_ms: 60_000,
      },
      {
        native_authorization_connector_phase: "failed",
        native_authorization_connector_elapsed_ms: 0,
      },
      {
        native_authorization_connector_phase: "not_started",
        native_authorization_connector_attempts: 0,
        native_authorization_connector_elapsed_ms: null,
      },
      {
        native_authorization_connector_phase: "multiple",
        native_authorization_connector_attempts: 2,
        native_authorization_connector_elapsed_ms: null,
      },
      {
        native_authorization_connector_phase: "multiple",
        native_authorization_connector_attempts: 8,
        native_authorization_connector_elapsed_ms: null,
      },
    ])(
      "joins the snapshot to a valid v1 group on a terminal-error final: %p",
      (change) => {
        const expected = { ...connector, ...change };
        const final = settle({
          ...terminalError,
          nativeAuthorization: group,
          nativeAuthorizationConnector: { ...expected, message: "PRIVATE" },
        });
        expect(final?.properties).toMatchObject({ ...group, ...expected });
        const enriched = enrich({
          ...final!.properties,
          native_authorization_connector_host: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({ ...group, ...expected });
        expect(connectorKeys(enriched.properties)).toHaveLength(4);
        expect(nativeKeys(enriched.properties)).toHaveLength(8);
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it("never reports a snapshot without a valid v1 group", () => {
      for (const nativeAuthorization of [
        undefined,
        { ...group, native_authorization_send_elapsed_ms: -1 },
      ]) {
        const final = settle({
          ...terminalError,
          nativeAuthorization,
          nativeAuthorizationConnector: connector,
        });
        expect(final?.properties).toMatchObject({ terminalType: "error" });
        expect(connectorKeys(final!.properties)).toEqual([]);
        expect(
          connectorKeys(
            enrich({
              terminalType: "error",
              ...nativeAuthorization,
              ...connector,
            }).properties,
          ),
        ).toEqual([]);
      }
      // Nor on a successful or nonzero exit, a start or a summary.
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorization: group,
        nativeAuthorizationConnector: connector,
      });
      expect(connectorKeys(exitFinal!.properties)).toEqual([]);
      expect(
        connectorKeys(
          enrich({ terminalType: "exit", ...group, ...connector }).properties,
        ),
      ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          connectorKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...group, ...connector },
            }).properties,
          ),
        ).toEqual([]);
    });

    it("never defaults a missing snapshot to a phase", () => {
      const final = settle({ ...terminalError, nativeAuthorization: group });
      expect(final?.properties).toMatchObject(group);
      expect(connectorKeys(final!.properties)).toEqual([]);
      expect(enrich({ terminalType: "error", ...group }).properties).toEqual({
        terminalType: "error",
        ...group,
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ["unsupported version", { native_authorization_connector_version: 2 }],
      ["string version", { native_authorization_connector_version: "1" }],
      [
        "missing version",
        { native_authorization_connector_version: undefined },
      ],
      ["guessed DNS phase", { native_authorization_connector_phase: "dns" }],
      [
        "guessed TLS phase",
        { native_authorization_connector_phase: "tls_handshake" },
      ],
      ["private phase", { native_authorization_connector_phase: "PRIVATE" }],
      ["missing phase", { native_authorization_connector_phase: undefined }],
      ["string attempts", { native_authorization_connector_attempts: "1" }],
      [
        "missing attempts",
        { native_authorization_connector_attempts: undefined },
      ],
      [
        "a single phase for two calls",
        { native_authorization_connector_attempts: 2 },
      ],
      [
        "a single call without its time",
        { native_authorization_connector_elapsed_ms: null },
      ],
      [
        "a missing time",
        { native_authorization_connector_elapsed_ms: undefined },
      ],
      ["unbounded time", { native_authorization_connector_elapsed_ms: 60_001 }],
      ["negative time", { native_authorization_connector_elapsed_ms: -1 }],
      ["fractional time", { native_authorization_connector_elapsed_ms: 0.5 }],
      ["NaN time", { native_authorization_connector_elapsed_ms: NaN }],
      ["string time", { native_authorization_connector_elapsed_ms: "31" }],
      [
        "multiple calls with one time",
        {
          native_authorization_connector_phase: "multiple",
          native_authorization_connector_attempts: 2,
        },
      ],
      [
        "an unbounded call count",
        {
          native_authorization_connector_phase: "multiple",
          native_authorization_connector_attempts: 9,
          native_authorization_connector_elapsed_ms: null,
        },
      ],
      [
        "a call counted without starting",
        {
          native_authorization_connector_phase: "not_started",
          native_authorization_connector_elapsed_ms: null,
        },
      ],
    ])("drops only the snapshot for %s", (_case, change) => {
      const invalid = { ...connector, ...change };
      const final = settle({
        ...terminalError,
        nativeAuthorization: group,
        nativeAuthorizationConnector: invalid,
      });
      // The original v1 group is unaffected.
      expect(final?.properties).toMatchObject(group);
      expect(connectorKeys(final!.properties)).toEqual([]);
      const enriched = enrich({ terminalType: "error", ...group, ...invalid });
      expect(enriched.properties).toEqual({ terminalType: "error", ...group });
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    it("never runs a snapshot getter at before_send and keeps the v1 group", () => {
      let reads = 0;
      const properties: Record<string, unknown> = {
        terminalType: "error",
        ...group,
        ...connector,
      };
      Object.defineProperty(
        properties,
        "native_authorization_connector_phase",
        {
          enumerable: true,
          get() {
            reads++;
            throw new Error("PRIVATE");
          },
        },
      );
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties,
      }).properties!;
      expect(reads).toBe(0);
      expect(connectorKeys(sanitized)).toEqual([]);
      expect(sanitized).toEqual({ terminalType: "error", ...group });
    });
  });
});

describe("native authorization response receipt", () => {
  const VERCEL_ID = "iad1::abcde-1700000000000-0123456789ab";
  const response: NativeAuthorizationResponseDiagnostic = {
    native_authorization_response_version: 1,
    native_authorization_response_http_status: 403,
    native_authorization_response_approval: "not_checked",
    native_authorization_response_origin_class: "canonical_production",
    native_authorization_response_platform: "windows",
    native_authorization_response_request_id_shape: "valid",
    native_authorization_response_request_id: VERCEL_ID,
  };
  const send: NativeAuthorizationDiagnostic = {
    native_authorization_diagnostic_version: 1,
    native_authorization_send_timeout: true,
    native_authorization_send_connect: false,
    native_authorization_send_request: false,
    native_authorization_send_elapsed_ms: 8000,
    native_authorization_origin_class: "localhost",
    native_app_version: "0.0.80",
    native_platform: "darwin",
  };
  const terminalError = {
    ...result,
    terminalType: "error" as const,
    terminalExitCode: null,
  };
  const responseKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      NATIVE_AUTHORIZATION_RESPONSE_PROPERTIES.has(key),
    );
  const sendKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES.has(key),
    );
  const settle = (settlement: Record<string, unknown>) => {
    capture.mockClear();
    telemetry.start({ connectionId: "connection", commandId: "rejected" })(
      settlement as never,
    );
    return capture.mock.calls.find(
      ([event]) => event.event === "desktop_ack_command_settled",
    )?.[0];
  };
  const enrich = (properties: Record<string, unknown>) =>
    sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: {
        ...properties,
        $current_url: "PRIVATE URL",
        native_authorization_response_body: "PRIVATE BODY",
        native_authorization_response_headers: "PRIVATE HEADERS",
      },
      $set: { email: "PRIVATE" },
    });

  it.each<Partial<NativeAuthorizationResponseDiagnostic>>([
    {},
    {
      native_authorization_response_http_status: 100,
      native_authorization_response_request_id_shape: "absent",
      native_authorization_response_request_id: null,
    },
    {
      native_authorization_response_http_status: 199,
      native_authorization_response_origin_class: "localhost",
    },
    { native_authorization_response_http_status: 307 },
    { native_authorization_response_http_status: 599 },
    {
      native_authorization_response_http_status: 200,
      native_authorization_response_approval: "json_error",
      native_authorization_response_request_id_shape: "unrecognized",
      native_authorization_response_request_id: null,
    },
    {
      native_authorization_response_http_status: 299,
      native_authorization_response_approval: "approved_false",
      native_authorization_response_request_id_shape: "unreadable",
      native_authorization_response_request_id: null,
    },
    {
      native_authorization_response_http_status: 201,
      native_authorization_response_approval: "missing",
    },
    {
      native_authorization_response_http_status: 200,
      native_authorization_response_approval: "invalid_type",
      native_authorization_response_origin_class: "unknown",
      native_authorization_response_platform: null,
    },
    {
      native_authorization_response_request_id:
        "cle1::iad1::sfo9::zz0z9-0000000000000-ffffffffffff",
    },
  ])(
    "keeps one complete response group on a terminal-error final: %p",
    (change) => {
      const expected = { ...response, ...change };
      const final = settle({
        ...terminalError,
        nativeAuthorizationResponse: { ...expected, message: "PRIVATE" },
      });
      expect(final?.properties).toMatchObject({
        ...expected,
        terminalType: "error",
        telemetry_sample_rate: 1,
      });
      // The response group neither needs nor supplies the send group.
      expect(sendKeys(final!.properties)).toEqual([]);
      const enriched = enrich(final!.properties);
      expect(enriched.properties).toMatchObject(expected);
      expect(responseKeys(enriched.properties)).toHaveLength(7);
      expect(sendKeys(enriched.properties)).toEqual([]);
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    },
  );

  it.each<[string, Record<string, unknown>]>([
    ["unsupported version", { native_authorization_response_version: 2 }],
    ["string version", { native_authorization_response_version: "1" }],
    ["missing version", { native_authorization_response_version: undefined }],
    ["status below 100", { native_authorization_response_http_status: 99 }],
    ["status above 599", { native_authorization_response_http_status: 600 }],
    ["fractional status", { native_authorization_response_http_status: 403.5 }],
    ["string status", { native_authorization_response_http_status: "403" }],
    ["NaN status", { native_authorization_response_http_status: NaN }],
    ["an approval", { native_authorization_response_approval: "approved" }],
    ["private approval", { native_authorization_response_approval: "PRIVATE" }],
    ["an unchecked 2xx", { native_authorization_response_http_status: 200 }],
    [
      "a parsed non-2xx",
      { native_authorization_response_approval: "json_error" },
    ],
    [
      "a parsed redirect",
      {
        native_authorization_response_http_status: 302,
        native_authorization_response_approval: "approved_false",
      },
    ],
    [
      "hostname origin",
      { native_authorization_response_origin_class: "hackerai.co" },
    ],
    ["raw target OS", { native_authorization_response_platform: "macos" }],
    ["unknown platform", { native_authorization_response_platform: "unknown" }],
    ["missing platform", { native_authorization_response_platform: undefined }],
    [
      "private shape",
      { native_authorization_response_request_id_shape: "PRIVATE" },
    ],
    [
      "valid shape without an ID",
      { native_authorization_response_request_id: null },
    ],
    [
      "an ID outside the subset",
      { native_authorization_response_request_id: "iad1::PRIVATE" },
    ],
    [
      "an ID with a query",
      { native_authorization_response_request_id: `${VERCEL_ID}?t=PRIVATE` },
    ],
    [
      "an ID with CRLF",
      { native_authorization_response_request_id: `${VERCEL_ID}\r\nPRIVATE` },
    ],
    [
      "an ID with a trailing newline",
      { native_authorization_response_request_id: `${VERCEL_ID}\n` },
    ],
    [
      "an uppercase ID",
      { native_authorization_response_request_id: VERCEL_ID.toUpperCase() },
    ],
    [
      "four region prefixes",
      {
        native_authorization_response_request_id: `cle1::${"iad1::".repeat(3)}abcde-1700000000000-0123456789ab`,
      },
    ],
    [
      "a huge ID",
      {
        native_authorization_response_request_id: `${"iad1::".repeat(10_000)}PRIVATE`,
      },
    ],
    [
      "an ID beside an unrecognized shape",
      { native_authorization_response_request_id_shape: "unrecognized" },
    ],
    [
      "an ID beside an absent shape",
      { native_authorization_response_request_id_shape: "absent" },
    ],
    ["missing ID", { native_authorization_response_request_id: undefined }],
  ])(
    "drops only the response group for %s and keeps the send group",
    (_case, change) => {
      const invalid = { ...response, ...change };
      const final = settle({
        ...terminalError,
        nativeAuthorization: send,
        nativeAuthorizationResponse: invalid,
      });
      expect(final?.properties).toMatchObject(send);
      expect(responseKeys(final!.properties)).toEqual([]);
      const enriched = enrich({ terminalType: "error", ...send, ...invalid });
      expect(enriched.properties).toEqual({ terminalType: "error", ...send });
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    },
  );

  it("keeps a valid response group when the send group is malformed", () => {
    const final = settle({
      ...terminalError,
      nativeAuthorization: { ...send, native_platform: "PRIVATE" },
      nativeAuthorizationResponse: response,
    });
    expect(sendKeys(final!.properties)).toEqual([]);
    expect(final?.properties).toMatchObject(response);
    // A valid response group never admits the send group's shared identity.
    const enriched = enrich({
      terminalType: "error",
      ...send,
      native_authorization_send_elapsed_ms: 60_001,
      ...response,
    });
    expect(enriched.properties).toEqual({ terminalType: "error", ...response });
  });

  it("does not attach the group to non-error finals, starts or summaries", () => {
    const exitFinal = settle({
      ...result,
      terminalExitCode: 1,
      nativeAuthorizationResponse: response,
    });
    expect(exitFinal?.properties).toMatchObject({ terminalExitCode: 1 });
    expect(responseKeys(exitFinal!.properties)).toEqual([]);
    for (const terminalType of ["exit", null, undefined])
      expect(
        responseKeys(enrich({ terminalType, ...response }).properties),
      ).toEqual([]);
    for (const event of [
      "desktop_ack_command_started",
      "desktop_ack_delivery_summary",
    ])
      expect(
        responseKeys(
          sanitizeDesktopAckEvent({
            event,
            properties: { terminalType: "error", ...response },
          }).properties,
        ),
      ).toEqual([]);
  });

  let reads = 0;
  it.each<[string, () => unknown]>([
    // Valid on the first read, a canary afterwards.
    ["valid-looking", () => (reads++ === 0 ? VERCEL_ID : "PRIVATE")],
    [
      "throwing",
      () => {
        reads++;
        throw new Error("PRIVATE");
      },
    ],
  ])(
    "never runs a %s response getter at capture or before_send",
    (_case, get) => {
      reads = 0;
      const hostile = (base: Record<string, unknown>) =>
        Object.defineProperty(
          { ...base },
          "native_authorization_response_request_id",
          { enumerable: true, get },
        );
      const final = settle({
        ...terminalError,
        nativeAuthorization: send,
        nativeAuthorizationResponse: hostile({ ...response }),
      });
      expect(responseKeys(final!.properties)).toEqual([]);
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties: hostile({ terminalType: "error", ...send, ...response }),
      }).properties!;
      expect(reads).toBe(0);
      expect(sanitized).toEqual({ terminalType: "error", ...send });
      expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
    },
  );

  describe("mitigation marker", () => {
    const mitigation: NativeAuthorizationMitigationDiagnostic = {
      native_authorization_response_mitigation_version: 1,
      native_authorization_response_mitigation: "challenge",
    };
    const mitigationKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_MITIGATION_PROPERTIES.has(key),
      );

    it.each([
      "absent",
      "challenge",
      "deny",
      "rate_limit",
      "other",
      "unreadable",
    ] as const)(
      "joins the %s class only beside a valid response group",
      (native_authorization_response_mitigation) => {
        const expected = {
          ...mitigation,
          native_authorization_response_mitigation,
        };
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: response,
          nativeAuthorizationMitigation: { ...expected, raw: "PRIVATE" },
        });
        expect(final?.properties).toMatchObject({ ...response, ...expected });
        expect(mitigationKeys(final!.properties)).toHaveLength(2);
        const enriched = enrich({
          ...final!.properties,
          native_authorization_response_mitigation_value: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({ ...response, ...expected });
        // The frozen response group is unchanged beside the marker.
        expect(responseKeys(enriched.properties)).toHaveLength(7);
        expect(mitigationKeys(enriched.properties)).toHaveLength(2);
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it.each<[string, Record<string, unknown>]>([
      [
        "unsupported version",
        { native_authorization_response_mitigation_version: 2 },
      ],
      [
        "string version",
        { native_authorization_response_mitigation_version: "1" },
      ],
      [
        "missing version",
        { native_authorization_response_mitigation_version: undefined },
      ],
      ["raw value", { native_authorization_response_mitigation: "PRIVATE" }],
      [
        "non-literal",
        { native_authorization_response_mitigation: "Challenge" },
      ],
      [
        "hyphenated",
        { native_authorization_response_mitigation: "rate-limit" },
      ],
      ["empty", { native_authorization_response_mitigation: "" }],
      ["null", { native_authorization_response_mitigation: null }],
      [
        "missing class",
        { native_authorization_response_mitigation: undefined },
      ],
    ])(
      "drops only the marker for %s and keeps the response group",
      (_case, change) => {
        const invalid = { ...mitigation, ...change };
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: response,
          nativeAuthorizationMitigation: invalid,
        });
        expect(final?.properties).toMatchObject(response);
        expect(mitigationKeys(final!.properties)).toEqual([]);
        const enriched = enrich({
          terminalType: "error",
          ...response,
          ...invalid,
        });
        expect(enriched.properties).toEqual({
          terminalType: "error",
          ...response,
        });
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it.each<[string, Record<string, unknown> | undefined]>([
      ["no response group", undefined],
      [
        "a malformed response group",
        { ...response, native_authorization_response_http_status: 200 },
      ],
    ])(
      "drops an orphan marker with %s and keeps the send group",
      (_case, invalid) => {
        const final = settle({
          ...terminalError,
          nativeAuthorization: send,
          ...(invalid && { nativeAuthorizationResponse: invalid }),
          nativeAuthorizationMitigation: mitigation,
        });
        expect(final?.properties).toMatchObject(send);
        expect(responseKeys(final!.properties)).toEqual([]);
        expect(mitigationKeys(final!.properties)).toEqual([]);
        const enriched = enrich({
          terminalType: "error",
          ...send,
          ...invalid,
          ...mitigation,
        });
        expect(enriched.properties).toEqual({ terminalType: "error", ...send });
      },
    );

    it("does not attach the marker to non-error finals, starts or summaries", () => {
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorizationResponse: response,
        nativeAuthorizationMitigation: mitigation,
      });
      expect(mitigationKeys(exitFinal!.properties)).toEqual([]);
      for (const terminalType of ["exit", null, undefined])
        expect(
          mitigationKeys(
            enrich({ terminalType, ...response, ...mitigation }).properties,
          ),
        ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          mitigationKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...response, ...mitigation },
            }).properties,
          ),
        ).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      // Valid on the first read, a canary afterwards.
      ["valid-looking", () => (reads++ === 0 ? "deny" : "PRIVATE")],
      [
        "throwing",
        () => {
          reads++;
          throw new Error("PRIVATE");
        },
      ],
    ])(
      "never runs a %s marker getter at capture or before_send",
      (_case, get) => {
        reads = 0;
        const hostile = (base: Record<string, unknown>) =>
          Object.defineProperty(
            { ...base },
            "native_authorization_response_mitigation",
            { enumerable: true, get },
          );
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: response,
          nativeAuthorizationMitigation: hostile({ ...mitigation }),
        });
        expect(final?.properties).toMatchObject(response);
        expect(mitigationKeys(final!.properties)).toEqual([]);
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: hostile({
            terminalType: "error",
            ...response,
            ...mitigation,
          }),
        }).properties!;
        expect(reads).toBe(0);
        expect(sanitized).toEqual({ terminalType: "error", ...response });
        expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
      },
    );
  });

  describe("JSON read snapshot", () => {
    const jsonResponse: NativeAuthorizationResponseDiagnostic = {
      ...response,
      native_authorization_response_http_status: 200,
      native_authorization_response_approval: "json_error",
      native_authorization_response_request_id_shape: "absent",
      native_authorization_response_request_id: null,
    };
    const read: NativeAuthorizationResponseReadDiagnostic = {
      native_authorization_response_read_version: 1,
      native_authorization_response_read_kind: "body_read",
      native_authorization_response_read_source_depth: 3,
      native_authorization_response_read_source_chain_truncated: false,
    };
    const readKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES.has(key),
      );
    const snapshot = (
      kind: NativeAuthorizationResponseReadDiagnostic["native_authorization_response_read_kind"],
      depth: number,
      truncated: boolean,
    ): NativeAuthorizationResponseReadDiagnostic => ({
      native_authorization_response_read_version: 1,
      native_authorization_response_read_kind: kind,
      native_authorization_response_read_source_depth: depth,
      native_authorization_response_read_source_chain_truncated: truncated,
    });

    it.each([
      snapshot("timeout", 2, false),
      snapshot("body_read", 3, false),
      snapshot("serde_eof", 1, false),
      snapshot("serde_syntax", 1, false),
      snapshot("serde_data", 1, false),
      snapshot("serde_io", 1, false),
      snapshot("unclassified", 0, false),
      snapshot("unclassified", 5, false),
      snapshot("unclassified", 8, true),
      snapshot("serde_eof", 8, true),
      snapshot("timeout", 8, true),
    ])(
      "keeps one complete read group beside a json_error response: %p",
      (expected) => {
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: jsonResponse,
          nativeAuthorizationResponseRead: { ...expected, message: "PRIVATE" },
        });
        expect(final?.properties).toMatchObject({
          ...jsonResponse,
          ...expected,
          terminalType: "error",
          telemetry_sample_rate: 1,
        });
        expect(readKeys(final!.properties)).toHaveLength(4);
        // Raw incoming keys are stripped before the validated copy.
        const enriched = enrich({
          ...final!.properties,
          native_authorization_response_read_message: "PRIVATE",
          native_authorization_response_read_type_name: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({
          ...jsonResponse,
          ...expected,
        });
        // The frozen response group is unchanged beside the read group.
        expect(responseKeys(enriched.properties)).toHaveLength(7);
        expect(readKeys(enriched.properties)).toHaveLength(4);
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it.each<[string, Record<string, unknown>]>([
      [
        "unsupported version",
        { native_authorization_response_read_version: 2 },
      ],
      ["string version", { native_authorization_response_read_version: "1" }],
      [
        "missing version",
        { native_authorization_response_read_version: undefined },
      ],
      ["private kind", { native_authorization_response_read_kind: "PRIVATE" }],
      ["decode kind", { native_authorization_response_read_kind: "decode" }],
      ["null kind", { native_authorization_response_read_kind: null }],
      ["missing kind", { native_authorization_response_read_kind: undefined }],
      [
        "negative depth",
        { native_authorization_response_read_source_depth: -1 },
      ],
      [
        "depth beyond the budget",
        { native_authorization_response_read_source_depth: 9 },
      ],
      [
        "fractional depth",
        { native_authorization_response_read_source_depth: 2.5 },
      ],
      ["NaN depth", { native_authorization_response_read_source_depth: NaN }],
      [
        "infinite depth",
        { native_authorization_response_read_source_depth: Infinity },
      ],
      [
        "string depth",
        { native_authorization_response_read_source_depth: "3" },
      ],
      [
        "missing depth",
        { native_authorization_response_read_source_depth: undefined },
      ],
      [
        "string truncation",
        { native_authorization_response_read_source_chain_truncated: "false" },
      ],
      [
        "numeric truncation",
        { native_authorization_response_read_source_chain_truncated: 0 },
      ],
      [
        "truncation below the budget",
        { native_authorization_response_read_source_chain_truncated: true },
      ],
      [
        "missing truncation",
        {
          native_authorization_response_read_source_chain_truncated: undefined,
        },
      ],
      [
        "a witnessed kind without a walked link",
        { native_authorization_response_read_source_depth: 0 },
      ],
    ])(
      "drops only the read group for %s and keeps the response group",
      (_case, change) => {
        const invalid = { ...read, ...change };
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: jsonResponse,
          nativeAuthorizationResponseRead: invalid,
        });
        expect(final?.properties).toMatchObject(jsonResponse);
        expect(readKeys(final!.properties)).toEqual([]);
        const enriched = enrich({
          terminalType: "error",
          ...jsonResponse,
          ...invalid,
        });
        expect(enriched.properties).toEqual({
          terminalType: "error",
          ...jsonResponse,
        });
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it("drops an inherited read group", () => {
      const inherited = Object.create(read) as object;
      const final = settle({
        ...terminalError,
        nativeAuthorizationResponse: jsonResponse,
        nativeAuthorizationResponseRead: inherited,
      });
      expect(final?.properties).toMatchObject(jsonResponse);
      expect(readKeys(final!.properties)).toEqual([]);
      const properties = Object.assign(Object.create(read) as object, {
        terminalType: "error",
        ...jsonResponse,
      });
      expect(
        sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties,
        }).properties,
      ).toEqual({ terminalType: "error", ...jsonResponse });
    });

    it.each<[string, Record<string, unknown> | undefined]>([
      ["no response group", undefined],
      ["an unread non-2xx response group", response],
      [
        "an approved_false response group",
        {
          ...jsonResponse,
          native_authorization_response_approval: "approved_false",
        },
      ],
      [
        "a missing-approval response group",
        { ...jsonResponse, native_authorization_response_approval: "missing" },
      ],
      [
        "an invalid-type response group",
        {
          ...jsonResponse,
          native_authorization_response_approval: "invalid_type",
        },
      ],
      [
        "a malformed json_error response group",
        { ...jsonResponse, native_authorization_response_http_status: 403 },
      ],
    ])(
      "drops a read group joined to %s and keeps the other groups",
      (_case, base) => {
        const final = settle({
          ...terminalError,
          nativeAuthorization: send,
          ...(base && { nativeAuthorizationResponse: base }),
          nativeAuthorizationResponseRead: read,
        });
        expect(final?.properties).toMatchObject(send);
        expect(readKeys(final!.properties)).toEqual([]);
        const enriched = enrich({
          terminalType: "error",
          ...send,
          ...base,
          ...read,
        });
        expect(readKeys(enriched.properties)).toEqual([]);
        expect(enriched.properties).toMatchObject({
          terminalType: "error",
          ...send,
        });
      },
    );

    it("does not attach the read group to non-error finals, starts or summaries", () => {
      const exitFinal = settle({
        ...result,
        terminalExitCode: 1,
        nativeAuthorizationResponse: jsonResponse,
        nativeAuthorizationResponseRead: read,
      });
      expect(exitFinal?.properties).toMatchObject({ terminalExitCode: 1 });
      expect(readKeys(exitFinal!.properties)).toEqual([]);
      for (const terminalType of ["exit", null, undefined])
        expect(
          readKeys(
            enrich({ terminalType, ...jsonResponse, ...read }).properties,
          ),
        ).toEqual([]);
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          readKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: { terminalType: "error", ...jsonResponse, ...read },
            }).properties,
          ),
        ).toEqual([]);
    });

    it.each<[string, () => unknown]>([
      // Valid on the first read, a canary afterwards.
      ["valid-looking", () => (reads++ === 0 ? "serde_eof" : "PRIVATE")],
      [
        "throwing",
        () => {
          reads++;
          throw new Error("PRIVATE");
        },
      ],
    ])(
      "never runs a %s read getter at capture or before_send",
      (_case, get) => {
        reads = 0;
        const hostile = (base: Record<string, unknown>) =>
          Object.defineProperty(
            { ...base },
            "native_authorization_response_read_kind",
            { enumerable: true, get },
          );
        const final = settle({
          ...terminalError,
          nativeAuthorizationResponse: jsonResponse,
          nativeAuthorizationResponseRead: hostile({ ...read }),
        });
        expect(final?.properties).toMatchObject(jsonResponse);
        expect(readKeys(final!.properties)).toEqual([]);
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: hostile({
            terminalType: "error",
            ...jsonResponse,
            ...read,
          }),
        }).properties!;
        expect(reads).toBe(0);
        expect(sanitized).toEqual({ terminalType: "error", ...jsonResponse });
        expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
      },
    );
  });

  describe("JSON read timeout timing", () => {
    const jsonResponse: NativeAuthorizationResponseDiagnostic = {
      ...response,
      native_authorization_response_http_status: 200,
      native_authorization_response_approval: "json_error",
      native_authorization_response_request_id_shape: "absent",
      native_authorization_response_request_id: null,
    };
    const timeoutRead: NativeAuthorizationResponseReadDiagnostic = {
      native_authorization_response_read_version: 1,
      native_authorization_response_read_kind: "timeout",
      native_authorization_response_read_source_depth: 2,
      native_authorization_response_read_source_chain_truncated: false,
    };
    const rejectedKind: DesktopTerminalErrorDiagnostic = {
      desktop_terminal_error_diagnostic_version: 1,
      desktop_terminal_error_kind: "invocation_rejected",
    };
    const rejection: DesktopInvocationRejectionDiagnostic = {
      desktop_invocation_rejection_version: 1,
      desktop_invocation_rejection_reason: "authorization_response_invalid",
      desktop_invocation_rejection_adapter: "authorized_native",
    };
    const timing: NativeAuthorizationResponseReadTimingDiagnostic = {
      native_authorization_response_read_timing_version: 1,
      native_authorization_response_read_timing_headers_elapsed_ms: 7480,
      native_authorization_response_read_timing_read_elapsed_ms: 512,
    };
    const timingKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES.has(key),
      );
    const readKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        NATIVE_AUTHORIZATION_RESPONSE_READ_PROPERTIES.has(key),
      );
    /** One settlement carrying every group the timing joins, as the bridge
     * hands it over. */
    const joined = (changes: Record<string, unknown> = {}) => ({
      ...terminalError,
      terminalError: rejectedKind,
      invocationRejection: rejection,
      nativeAuthorizationResponse: jsonResponse,
      nativeAuthorizationResponseRead: timeoutRead,
      nativeAuthorizationResponseReadTiming: timing,
      ...changes,
    });
    /** The same groups flattened, as a settled event's properties. */
    const flat = (changes: Record<string, unknown> = {}) => ({
      terminalType: "error",
      ...jsonResponse,
      ...timeoutRead,
      ...rejectedKind,
      ...rejection,
      ...timing,
      ...changes,
    });

    it.each<[number, number]>([
      [7480, 512],
      [0, 0],
      [60_000, 60_000],
    ])(
      "keeps one complete timing group beside its classified read timeout: %p ms, %p ms",
      (headers, read) => {
        const expected = {
          ...timing,
          native_authorization_response_read_timing_headers_elapsed_ms: headers,
          native_authorization_response_read_timing_read_elapsed_ms: read,
        };
        const final = settle(
          joined({
            nativeAuthorizationResponseReadTiming: {
              ...expected,
              native_authorization_response_read_timing_deadline_ms: 8000,
              message: "PRIVATE",
            },
          }),
        );
        expect(final?.properties).toMatchObject({
          ...jsonResponse,
          ...timeoutRead,
          ...rejection,
          ...expected,
          terminalType: "error",
          telemetry_sample_rate: 1,
        });
        expect(timingKeys(final!.properties)).toHaveLength(3);
        expect(final!.properties).not.toHaveProperty(
          "native_authorization_response_read_timing_deadline_ms",
        );
        // Raw incoming keys are stripped before the validated copy.
        const enriched = enrich({
          ...final!.properties,
          native_authorization_response_read_timing_deadline_ms: 8000,
          native_authorization_response_read_timing_message: "PRIVATE",
        });
        expect(enriched.properties).toMatchObject({
          ...jsonResponse,
          ...timeoutRead,
          ...expected,
        });
        // The frozen response and read groups are unchanged beside it.
        expect(responseKeys(enriched.properties)).toHaveLength(7);
        expect(readKeys(enriched.properties)).toHaveLength(4);
        expect(timingKeys(enriched.properties)).toHaveLength(3);
        expect(enriched.properties).not.toHaveProperty(
          "native_authorization_response_read_timing_deadline_ms",
        );
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      },
    );

    it("keeps every other group unchanged without a timing group", () => {
      // A current frontend beside an older native app, or an older frontend.
      const final = settle(
        joined({ nativeAuthorizationResponseReadTiming: undefined }),
      );
      expect(final?.properties).toMatchObject({
        ...jsonResponse,
        ...timeoutRead,
        ...rejection,
      });
      expect(timingKeys(final!.properties)).toEqual([]);
      const without = { ...flat() } as Record<string, unknown>;
      for (const key of NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES)
        delete without[key];
      const enriched = enrich(without);
      expect(timingKeys(enriched.properties)).toEqual([]);
      expect(readKeys(enriched.properties)).toHaveLength(4);
      expect(responseKeys(enriched.properties)).toHaveLength(7);
    });

    it.each<[string, Record<string, unknown>]>([
      [
        "unsupported version",
        { native_authorization_response_read_timing_version: 2 },
      ],
      [
        "missing version",
        { native_authorization_response_read_timing_version: undefined },
      ],
      [
        "string duration",
        { native_authorization_response_read_timing_read_elapsed_ms: "512" },
      ],
      [
        "negative duration",
        { native_authorization_response_read_timing_headers_elapsed_ms: -1 },
      ],
      [
        "duration beyond the bound",
        { native_authorization_response_read_timing_read_elapsed_ms: 60_001 },
      ],
      [
        "fractional duration",
        { native_authorization_response_read_timing_headers_elapsed_ms: 1.5 },
      ],
      [
        "NaN duration",
        { native_authorization_response_read_timing_read_elapsed_ms: NaN },
      ],
      [
        "infinite duration",
        {
          native_authorization_response_read_timing_headers_elapsed_ms:
            Infinity,
        },
      ],
      [
        "null duration",
        { native_authorization_response_read_timing_read_elapsed_ms: null },
      ],
      [
        "missing duration",
        {
          native_authorization_response_read_timing_headers_elapsed_ms:
            undefined,
        },
      ],
    ])(
      "drops only the timing group for %s and keeps the other groups",
      (_case, change) => {
        const invalid = { ...timing, ...change };
        const final = settle(
          joined({ nativeAuthorizationResponseReadTiming: invalid }),
        );
        expect(final?.properties).toMatchObject({
          ...jsonResponse,
          ...timeoutRead,
          ...rejection,
        });
        expect(timingKeys(final!.properties)).toEqual([]);
        const enriched = enrich(flat(change));
        expect(timingKeys(enriched.properties)).toEqual([]);
        expect(enriched.properties).toMatchObject({
          ...jsonResponse,
          ...timeoutRead,
          ...rejection,
        });
      },
    );

    it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
      [
        "a non-timeout read",
        {
          nativeAuthorizationResponseRead: {
            ...timeoutRead,
            native_authorization_response_read_kind: "body_read",
          },
        },
        { native_authorization_response_read_kind: "body_read" },
      ],
      [
        "no read group",
        { nativeAuthorizationResponseRead: undefined },
        { native_authorization_response_read_version: undefined },
      ],
      [
        "an approved_false response",
        {
          nativeAuthorizationResponse: {
            ...jsonResponse,
            native_authorization_response_approval: "approved_false",
          },
        },
        { native_authorization_response_approval: "approved_false" },
      ],
      [
        "an unread non-2xx response",
        { nativeAuthorizationResponse: response },
        response,
      ],
      [
        "no response group",
        { nativeAuthorizationResponse: undefined },
        { native_authorization_response_version: undefined },
      ],
      [
        "another rejection class",
        {
          invocationRejection: {
            ...rejection,
            desktop_invocation_rejection_reason: "authorization_not_approved",
          },
        },
        { desktop_invocation_rejection_reason: "authorization_not_approved" },
      ],
      [
        "no rejection class",
        { invocationRejection: undefined },
        { desktop_invocation_rejection_version: undefined },
      ],
      [
        "a legacy command set",
        {
          invocationRejection: {
            ...rejection,
            desktop_invocation_rejection_adapter: "published_legacy_native",
          },
        },
        { desktop_invocation_rejection_adapter: "published_legacy_native" },
      ],
      [
        "another terminal error kind",
        {
          terminalError: {
            ...rejectedKind,
            desktop_terminal_error_kind: "native_command_timeout",
          },
        },
        { desktop_terminal_error_kind: "native_command_timeout" },
      ],
    ])(
      "drops a timing group joined to %s",
      (_case, settlementChange, propertiesChange) => {
        const final = settle(joined(settlementChange));
        expect(final?.properties).toMatchObject({ terminalType: "error" });
        expect(timingKeys(final!.properties)).toEqual([]);
        const enriched = enrich(flat(propertiesChange));
        expect(timingKeys(enriched.properties)).toEqual([]);
      },
    );

    it("does not attach the timing group to non-error finals, starts or summaries", () => {
      const exitFinal = settle(
        joined({ terminalType: "exit", terminalExitCode: 0 }),
      );
      expect(exitFinal?.properties).toMatchObject({ terminalType: "exit" });
      expect(timingKeys(exitFinal!.properties)).toEqual([]);
      for (const terminalType of ["exit", null, undefined])
        expect(timingKeys(enrich(flat({ terminalType })).properties)).toEqual(
          [],
        );
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          timingKeys(
            sanitizeDesktopAckEvent({ event, properties: flat() }).properties,
          ),
        ).toEqual([]);
    });

    it("drops an inherited timing group", () => {
      const inherited = Object.create(timing) as object;
      const final = settle(
        joined({ nativeAuthorizationResponseReadTiming: inherited }),
      );
      expect(final?.properties).toMatchObject(timeoutRead);
      expect(timingKeys(final!.properties)).toEqual([]);
      const own = { ...flat() } as Record<string, unknown>;
      for (const key of NATIVE_AUTHORIZATION_RESPONSE_READ_TIMING_PROPERTIES)
        delete own[key];
      const properties = Object.assign(Object.create(timing) as object, own);
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties,
      }).properties!;
      expect(timingKeys(sanitized)).toEqual([]);
      expect(sanitized).toMatchObject(timeoutRead);
    });

    it.each<[string, () => unknown]>([
      // Valid on the first read, a canary afterwards.
      ["valid-looking", () => (reads++ === 0 ? 512 : "PRIVATE")],
      [
        "throwing",
        () => {
          reads++;
          throw new Error("PRIVATE");
        },
      ],
    ])(
      "never runs a %s timing getter at capture or before_send",
      (_case, get) => {
        reads = 0;
        const hostile = (base: Record<string, unknown>) =>
          Object.defineProperty(
            { ...base },
            "native_authorization_response_read_timing_read_elapsed_ms",
            { enumerable: true, get },
          );
        const final = settle(
          joined({ nativeAuthorizationResponseReadTiming: hostile(timing) }),
        );
        expect(final?.properties).toMatchObject(timeoutRead);
        expect(timingKeys(final!.properties)).toEqual([]);
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: hostile(flat()),
        }).properties!;
        expect(reads).toBe(0);
        expect(timingKeys(sanitized)).toEqual([]);
        expect(sanitized).toMatchObject({ ...timeoutRead, ...rejection });
        expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
      },
    );
  });
});

describe("first terminal error kind", () => {
  const kindGroup: DesktopTerminalErrorDiagnostic = {
    desktop_terminal_error_diagnostic_version: 1,
    desktop_terminal_error_kind: "native_command_timeout",
  };
  const sendGroup: NativeAuthorizationDiagnostic = {
    native_authorization_diagnostic_version: 1,
    native_authorization_send_timeout: true,
    native_authorization_send_connect: false,
    native_authorization_send_request: false,
    native_authorization_send_elapsed_ms: 8000,
    native_authorization_origin_class: "canonical_production",
    native_app_version: "0.0.80",
    native_platform: "darwin",
  };
  const terminalError = {
    ...result,
    terminalType: "error" as const,
    terminalExitCode: null,
  };
  const kindKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      DESKTOP_TERMINAL_ERROR_PROPERTIES.has(key),
    );
  const settle = (settlement: Record<string, unknown>) => {
    capture.mockClear();
    telemetry.start({ connectionId: "connection", commandId: "command" })(
      settlement as never,
    );
    return capture.mock.calls.find(
      ([event]) => event.event === "desktop_ack_command_settled",
    )?.[0];
  };
  const enrich = (properties: Record<string, unknown>) =>
    sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: { ...properties, $current_url: "PRIVATE URL" },
      $set: { email: "PRIVATE" },
    });

  it.each([
    "native_command_timeout",
    "native_process_error",
    "native_other",
    "invocation_rejected",
  ] as const)(
    "keeps %s beside existing groups through capture and before_send",
    (kind) => {
      const expected = { ...kindGroup, desktop_terminal_error_kind: kind };
      const final = settle({
        ...terminalError,
        nativeAuthorization: sendGroup,
        terminalError: { ...expected, message: "PRIVATE" },
      });
      expect(final?.properties).toMatchObject({
        ...sendGroup,
        ...expected,
        terminalType: "error",
        outcome: "acknowledged",
      });
      const enriched = enrich(final!.properties);
      expect(enriched.properties).toMatchObject({ ...sendGroup, ...expected });
      expect(kindKeys(enriched.properties)).toHaveLength(2);
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    },
  );

  it("never attaches a kind to an exit, unknown terminal, start or summary", () => {
    for (const terminalType of ["exit", null]) {
      const final = settle({
        ...result,
        terminalType,
        terminalExitCode: terminalType ? 1 : null,
        terminalError: kindGroup,
      });
      expect(final?.properties).toMatchObject({ terminalType });
      expect(kindKeys(final!.properties)).toEqual([]);
      expect(
        kindKeys(enrich({ terminalType, ...kindGroup }).properties),
      ).toEqual([]);
    }
    for (const event of [
      "desktop_ack_command_started",
      "desktop_ack_delivery_summary",
    ])
      expect(
        kindKeys(
          sanitizeDesktopAckEvent({
            event,
            properties: { terminalType: "error", ...kindGroup },
          }).properties,
        ),
      ).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a missing kind", { desktop_terminal_error_kind: undefined }],
    [
      "a missing version",
      { desktop_terminal_error_diagnostic_version: undefined },
    ],
    [
      "an unsupported version",
      { desktop_terminal_error_diagnostic_version: 2 },
    ],
    ["a private kind", { desktop_terminal_error_kind: "PRIVATE" }],
    [
      "a raw native message",
      { desktop_terminal_error_kind: "Process error: PRIVATE" },
    ],
  ])("drops only the kind group for %s", (_case, change) => {
    const invalid = { ...kindGroup, ...change };
    const final = settle({
      ...terminalError,
      nativeAuthorization: sendGroup,
      terminalError: invalid,
    });
    expect(final?.properties).toMatchObject(sendGroup);
    expect(kindKeys(final!.properties)).toEqual([]);
    const enriched = enrich({
      terminalType: "error",
      ...sendGroup,
      ...invalid,
    });
    expect(enriched.properties).toEqual({
      terminalType: "error",
      ...sendGroup,
    });
    expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
  });

  it("never runs a kind accessor at capture or before_send", () => {
    let reads = 0;
    const withAccessor = (target: Record<string, unknown>) =>
      Object.defineProperty(target, "desktop_terminal_error_kind", {
        enumerable: true,
        get() {
          reads++;
          return "PRIVATE";
        },
      });
    const final = settle({
      ...terminalError,
      terminalError: withAccessor({ ...kindGroup }),
    });
    expect(kindKeys(final!.properties)).toEqual([]);
    const sanitized = sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: withAccessor({ terminalType: "error", ...kindGroup }),
    }).properties!;
    expect(reads).toBe(0);
    expect(sanitized).toEqual({ terminalType: "error" });
  });
});

describe("invocation rejection message class", () => {
  const rejectedKind: DesktopTerminalErrorDiagnostic = {
    desktop_terminal_error_diagnostic_version: 1,
    desktop_terminal_error_kind: "invocation_rejected",
  };
  const rejection: DesktopInvocationRejectionDiagnostic = {
    desktop_invocation_rejection_version: 1,
    desktop_invocation_rejection_reason: "authorization_not_approved",
    desktop_invocation_rejection_adapter: "authorized_native",
  };
  const terminalError = {
    ...result,
    terminalType: "error" as const,
    terminalExitCode: null,
  };
  const rejectionKeys = (properties: Record<string, unknown> = {}) =>
    Object.keys(properties).filter((key) =>
      DESKTOP_INVOCATION_REJECTION_PROPERTIES.has(key),
    );
  const settle = (settlement: Record<string, unknown>) => {
    capture.mockClear();
    telemetry.start({ connectionId: "connection", commandId: "command" })(
      settlement as never,
    );
    return capture.mock.calls.find(
      ([event]) => event.event === "desktop_ack_command_settled",
    )?.[0];
  };
  const sanitize = (properties: Record<string, unknown>) =>
    sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: { ...properties, $current_url: "PRIVATE URL" },
      $set: { email: "PRIVATE" },
    }).properties!;

  it("keeps an unselected unknown class through capture and before_send", () => {
    const unselected = {
      ...rejection,
      desktop_invocation_rejection_reason: "unknown",
      desktop_invocation_rejection_adapter: "not_selected",
    };
    const final = settle({
      ...terminalError,
      terminalError: rejectedKind,
      invocationRejection: unselected,
    });
    expect(final?.properties).toMatchObject(unselected);
    expect(sanitize(final!.properties)).toMatchObject({
      ...rejectedKind,
      ...unselected,
    });
  });

  it("keeps the class beside the rejection kind through capture and before_send", () => {
    const final = settle({
      ...terminalError,
      terminalError: rejectedKind,
      invocationRejection: { ...rejection, message: "PRIVATE" },
    });
    expect(final?.properties).toMatchObject({
      ...rejectedKind,
      ...rejection,
      terminalType: "error",
    });
    const sanitized = sanitize(final!.properties);
    expect(sanitized).toMatchObject({ ...rejectedKind, ...rejection });
    expect(rejectionKeys(sanitized)).toHaveLength(3);
    expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
  });

  it.each<[string, Record<string, unknown>]>([
    [
      "a native timeout kind",
      {
        terminalError: {
          ...rejectedKind,
          desktop_terminal_error_kind: "native_command_timeout",
        },
      },
    ],
    ["no kind", { terminalError: undefined }],
    [
      "an invalid kind",
      {
        terminalError: {
          ...rejectedKind,
          desktop_terminal_error_diagnostic_version: 2,
        },
      },
    ],
    ["an exit", { terminalType: "exit", terminalExitCode: 1 }],
  ])("never attaches the class to %s", (_case, change) => {
    const settlement = {
      ...terminalError,
      terminalError: rejectedKind,
      invocationRejection: rejection,
      ...change,
    };
    const final = settle(settlement);
    expect(rejectionKeys(final!.properties)).toEqual([]);
    const { terminalError: kind, invocationRejection, ...rest } = settlement;
    const sanitized = sanitize({
      ...rest,
      ...(kind as object),
      ...(invocationRejection as object),
    });
    expect(rejectionKeys(sanitized)).toEqual([]);
  });

  it("never attaches the class to a start or summary", () => {
    for (const event of [
      "desktop_ack_command_started",
      "desktop_ack_delivery_summary",
    ])
      expect(
        rejectionKeys(
          sanitizeDesktopAckEvent({
            event,
            properties: {
              terminalType: "error",
              ...rejectedKind,
              ...rejection,
            },
          }).properties,
        ),
      ).toEqual([]);
  });

  it.each<[string, Record<string, unknown>]>([
    ["a missing reason", { desktop_invocation_rejection_reason: undefined }],
    ["an unsupported version", { desktop_invocation_rejection_version: 2 }],
    ["a private reason", { desktop_invocation_rejection_reason: "PRIVATE" }],
    [
      "a raw native message",
      {
        desktop_invocation_rejection_reason: "Failed to spawn: PRIVATE",
      },
    ],
    [
      "an authorization reason from a legacy command",
      { desktop_invocation_rejection_adapter: "published_legacy_native" },
    ],
    [
      "the file loopback adapter",
      { desktop_invocation_rejection_adapter: "legacy_loopback" },
    ],
    [
      "a native class without a selected command set",
      { desktop_invocation_rejection_adapter: "not_selected" },
    ],
  ])("drops only the class group for %s", (_case, change) => {
    const invalid = { ...rejection, ...change };
    const final = settle({
      ...terminalError,
      terminalError: rejectedKind,
      invocationRejection: invalid,
    });
    expect(final?.properties).toMatchObject(rejectedKind);
    expect(rejectionKeys(final!.properties)).toEqual([]);
    expect(
      sanitize({ terminalType: "error", ...rejectedKind, ...invalid }),
    ).toEqual({ terminalType: "error", ...rejectedKind });
    expect(JSON.stringify(final)).not.toContain("PRIVATE");
  });

  it("never runs a class accessor or proxy trap at capture or before_send", () => {
    let reads = 0;
    const withAccessor = (target: Record<string, unknown>) =>
      Object.defineProperty(target, "desktop_invocation_rejection_reason", {
        enumerable: true,
        get() {
          reads++;
          return "PRIVATE";
        },
      });
    const fail = () => {
      throw new Error("PRIVATE");
    };
    for (const invocationRejection of [
      withAccessor({ ...rejection }),
      new Proxy(
        { ...rejection },
        { get: fail, getOwnPropertyDescriptor: fail },
      ),
    ]) {
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection,
      });
      expect(final?.properties).toMatchObject(rejectedKind);
      expect(rejectionKeys(final!.properties)).toEqual([]);
    }
    const sanitized = sanitizeDesktopAckEvent({
      event: "desktop_ack_command_settled",
      properties: withAccessor({
        terminalType: "error",
        ...rejectedKind,
        ...rejection,
      }),
    }).properties!;
    expect(reads).toBe(0);
    expect(sanitized).toEqual({ terminalType: "error", ...rejectedKind });
  });

  describe("execution admission class", () => {
    const executionAdmission: DesktopInvocationRejectionDiagnostic = {
      ...rejection,
      desktop_invocation_rejection_reason: "execution_admission",
      desktop_invocation_rejection_adapter: "compatibility_native",
    };
    const admission: DesktopInvocationAdmissionDiagnostic = {
      desktop_invocation_admission_version: 1,
      desktop_invocation_admission_reason: "update_installing",
    };
    const admissionKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        DESKTOP_INVOCATION_ADMISSION_PROPERTIES.has(key),
      );

    it("keeps the pair beside the class and kind through capture and before_send", () => {
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: executionAdmission,
        invocationAdmission: { ...admission, stdin: "PRIVATE" },
      });
      const expected = { ...rejectedKind, ...executionAdmission, ...admission };
      expect(final?.properties).toMatchObject(expected);
      const sanitized = sanitize(final!.properties);
      expect(sanitized).toMatchObject(expected);
      expect(admissionKeys(sanitized)).toHaveLength(2);
      expect(JSON.stringify([final, sanitized])).not.toContain("PRIVATE");
    });

    it.each<[string, Record<string, unknown>]>([
      [
        "a missing version",
        { desktop_invocation_admission_version: undefined },
      ],
      ["a string version", { desktop_invocation_admission_version: "1" }],
      ["an unsupported version", { desktop_invocation_admission_version: 2 }],
      ["a missing reason", { desktop_invocation_admission_reason: undefined }],
      ["a private reason", { desktop_invocation_admission_reason: "PRIVATE" }],
      [
        "a raw native message",
        {
          desktop_invocation_admission_reason:
            "Desktop is installing an update. Reopen the app before retrying.",
        },
      ],
    ])("drops only the admission pair for %s", (_case, change) => {
      const invalid = { ...admission, ...change };
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: executionAdmission,
        invocationAdmission: invalid,
      });
      expect(final?.properties).toMatchObject({
        ...rejectedKind,
        ...executionAdmission,
      });
      expect(admissionKeys(final!.properties)).toEqual([]);
      expect(
        sanitize({
          terminalType: "error",
          ...rejectedKind,
          ...executionAdmission,
          ...invalid,
        }),
      ).toEqual({
        terminalType: "error",
        ...rejectedKind,
        ...executionAdmission,
      });
      expect(JSON.stringify(final)).not.toContain("PRIVATE");
      expect(JSON.stringify(final)).not.toContain("Reopen");
    });

    it.each<[string, Record<string, unknown>]>([
      ["another class", { invocationRejection: rejection }],
      [
        "an invalid class",
        {
          invocationRejection: {
            ...executionAdmission,
            desktop_invocation_rejection_adapter: "not_selected",
          },
        },
      ],
      ["no class", { invocationRejection: undefined }],
      [
        "a native timeout kind",
        {
          terminalError: {
            ...rejectedKind,
            desktop_terminal_error_kind: "native_command_timeout",
          },
        },
      ],
      ["an exit", { terminalType: "exit", terminalExitCode: 1 }],
    ])("never attaches the pair to %s", (_case, change) => {
      const settlement = {
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: executionAdmission,
        invocationAdmission: admission,
        ...change,
      };
      const final = settle(settlement);
      expect(admissionKeys(final!.properties)).toEqual([]);
      const {
        terminalError: kind,
        invocationRejection,
        invocationAdmission,
        ...rest
      } = settlement;
      const sanitized = sanitize({
        ...rest,
        ...(kind as object),
        ...(invocationRejection as object),
        ...(invocationAdmission as object),
      });
      expect(admissionKeys(sanitized)).toEqual([]);
      // The coarse class is unaffected by the pair it did not admit.
      expect(rejectionKeys(sanitized)).toEqual(
        rejectionKeys(final!.properties),
      );
    });

    it("never runs an admission accessor at capture or before_send", () => {
      let reads = 0;
      const withAccessor = (target: Record<string, unknown>) =>
        Object.defineProperty(target, "desktop_invocation_admission_reason", {
          enumerable: true,
          get() {
            reads++;
            return "update_installing";
          },
        });
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: executionAdmission,
        invocationAdmission: withAccessor({ ...admission }),
      });
      expect(final?.properties).toMatchObject(executionAdmission);
      expect(admissionKeys(final!.properties)).toEqual([]);
      const sanitized = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties: withAccessor({
          terminalType: "error",
          ...rejectedKind,
          ...executionAdmission,
          ...admission,
        }),
      }).properties!;
      expect(reads).toBe(0);
      expect(sanitized).toEqual({
        terminalType: "error",
        ...rejectedKind,
        ...executionAdmission,
      });
    });
  });

  describe("spawn OS code hint", () => {
    const spawnFailed: DesktopInvocationRejectionDiagnostic = {
      ...rejection,
      desktop_invocation_rejection_reason: "spawn_failed",
      desktop_invocation_rejection_adapter: "published_legacy_native",
    };
    const hint: DesktopInvocationSpawnHintDiagnostic = {
      desktop_invocation_spawn_hint_version: 1,
      desktop_invocation_spawn_os_code_hint: "code_193",
    };
    const hintKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES.has(key),
      );

    it("keeps the pair beside the class and kind through capture and before_send", () => {
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: spawnFailed,
        invocationSpawnHint: { ...hint, message: "PRIVATE (os error 193)" },
      });
      const expected = { ...rejectedKind, ...spawnFailed, ...hint };
      expect(final?.properties).toMatchObject(expected);
      const enriched = sanitizeDesktopAckEvent({
        event: "desktop_ack_command_settled",
        properties: { ...final!.properties, $current_url: "PRIVATE URL" },
        $set: { email: "PRIVATE" },
        $set_once: { email: "PRIVATE" },
      });
      expect(enriched.properties).toMatchObject(expected);
      expect(hintKeys(enriched.properties)).toHaveLength(2);
      expect(enriched).not.toHaveProperty("$set");
      expect(enriched).not.toHaveProperty("$set_once");
      expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
    });

    it("keeps an unsampled spawn hint at the diagnostic rate under the same key", () => {
      jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: spawnFailed,
        invocationSpawnHint: hint,
      });
      expect(final).toMatchObject({
        dedupeKey: JSON.stringify(["connection", "command"]),
        properties: {
          ...spawnFailed,
          ...hint,
          telemetry_sampled: false,
          telemetry_sample_rate: 1,
        },
      });
      expect(capture.mock.calls.map(([event]) => event.event)).not.toContain(
        "desktop_ack_command_started",
      );
    });

    it.each<[string, Record<string, unknown>]>([
      [
        "a missing version",
        { desktop_invocation_spawn_hint_version: undefined },
      ],
      ["a string version", { desktop_invocation_spawn_hint_version: "1" }],
      ["an unsupported version", { desktop_invocation_spawn_hint_version: 2 }],
      ["a missing hint", { desktop_invocation_spawn_os_code_hint: undefined }],
      ["an unlisted code", { desktop_invocation_spawn_os_code_hint: "code_4" }],
      [
        "a raw suffix",
        { desktop_invocation_spawn_os_code_hint: "PRIVATE (os error 2)" },
      ],
    ])("drops only the hint pair for %s", (_case, change) => {
      const invalid = { ...hint, ...change };
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: spawnFailed,
        invocationSpawnHint: invalid,
      });
      expect(final?.properties).toMatchObject({
        ...rejectedKind,
        ...spawnFailed,
      });
      expect(hintKeys(final!.properties)).toEqual([]);
      expect(
        sanitize({
          terminalType: "error",
          ...rejectedKind,
          ...spawnFailed,
          ...invalid,
        }),
      ).toEqual({ terminalType: "error", ...rejectedKind, ...spawnFailed });
      expect(JSON.stringify(final)).not.toContain("PRIVATE");
    });

    it.each<[string, Record<string, unknown>]>([
      ["another class", { invocationRejection: rejection }],
      [
        "an admission class",
        {
          invocationRejection: {
            ...spawnFailed,
            desktop_invocation_rejection_reason: "execution_admission",
          },
        },
      ],
      [
        "an unselected class",
        {
          invocationRejection: {
            ...spawnFailed,
            desktop_invocation_rejection_reason: "unknown",
            desktop_invocation_rejection_adapter: "not_selected",
          },
        },
      ],
      [
        "an invalid class",
        {
          invocationRejection: {
            ...spawnFailed,
            desktop_invocation_rejection_adapter: "not_selected",
          },
        },
      ],
      ["no class", { invocationRejection: undefined }],
      [
        "a native process kind",
        {
          terminalError: {
            ...rejectedKind,
            desktop_terminal_error_kind: "native_process_error",
          },
        },
      ],
      ["a nonzero exit", { terminalType: "exit", terminalExitCode: 127 }],
    ])("never attaches the pair to %s", (_case, change) => {
      const settlement = {
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: spawnFailed,
        invocationSpawnHint: hint,
        ...change,
      };
      const final = settle(settlement);
      expect(hintKeys(final!.properties)).toEqual([]);
      const {
        terminalError: kind,
        invocationRejection,
        invocationSpawnHint,
        ...rest
      } = settlement;
      const sanitized = sanitize({
        ...rest,
        ...(kind as object),
        ...(invocationRejection as object),
        ...(invocationSpawnHint as object),
      });
      expect(hintKeys(sanitized)).toEqual([]);
      // The coarse class is unaffected by the pair it did not admit.
      expect(rejectionKeys(sanitized)).toEqual(
        rejectionKeys(final!.properties),
      );
    });

    it("never attaches the pair to a start or summary", () => {
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          hintKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: {
                terminalType: "error",
                ...rejectedKind,
                ...spawnFailed,
                ...hint,
              },
            }).properties,
          ),
        ).toEqual([]);
    });

    it("strips hostile hint keys before any value access at capture or before_send", () => {
      let reads = 0;
      const withAccessors = (target: Record<string, unknown>) => {
        for (const key of DESKTOP_INVOCATION_SPAWN_HINT_PROPERTIES)
          Object.defineProperty(target, key, {
            enumerable: true,
            get() {
              reads++;
              return key.endsWith("version") ? 1 : "code_2";
            },
          });
        return target;
      };
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: spawnFailed,
        invocationSpawnHint: withAccessors({}),
      });
      expect(final?.properties).toMatchObject(spawnFailed);
      expect(hintKeys(final!.properties)).toEqual([]);
      // Both inside and outside the gate, a raw key is never read or kept.
      for (const coarse of [spawnFailed, rejection]) {
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: withAccessors({
            terminalType: "error",
            ...rejectedKind,
            ...coarse,
          }),
        }).properties!;
        expect(sanitized).toEqual({
          terminalType: "error",
          ...rejectedKind,
          ...coarse,
        });
      }
      // An inherited pair is not the event's own data.
      const inherited = Object.assign(Object.create(hint as object), {
        terminalType: "error",
        ...rejectedKind,
        ...spawnFailed,
      }) as Record<string, unknown>;
      expect(
        hintKeys(
          sanitizeDesktopAckEvent({
            event: "desktop_ack_command_settled",
            properties: inherited,
          }).properties,
        ),
      ).toEqual([]);
      expect(reads).toBe(0);
    });
  });

  describe("unknown invocation class", () => {
    const authorizedUnknown: DesktopInvocationRejectionDiagnostic = {
      ...rejection,
      desktop_invocation_rejection_reason: "unknown",
    };
    const unknown: DesktopInvocationUnknownDiagnostic = {
      desktop_invocation_unknown_version: 1,
      desktop_invocation_unknown_class: "lifecycle_stop_unconfirmed",
    };
    const stopMessage =
      "Desktop could not confirm an earlier command stopped. New commands are blocked for this session. Close and reopen Desktop before running more commands.";
    const unknownKeys = (properties: Record<string, unknown> = {}) =>
      Object.keys(properties).filter((key) =>
        DESKTOP_INVOCATION_UNKNOWN_PROPERTIES.has(key),
      );

    it.each([
      "lifecycle_page_replaced",
      "lifecycle_prior_cleanup_pending",
      "lifecycle_stop_unconfirmed",
      "other_string",
      "other_error_message",
      "message_over_limit",
      "message_unavailable",
    ])(
      "keeps the %s pair beside the class and kind through capture and before_send",
      (cls) => {
        const pair = { ...unknown, desktop_invocation_unknown_class: cls };
        const final = settle({
          ...terminalError,
          terminalError: rejectedKind,
          invocationRejection: authorizedUnknown,
          // Private extras on the same carrier never survive the copy.
          invocationUnknown: { ...pair, message: stopMessage, cwd: "PRIVATE" },
        });
        const expected = { ...rejectedKind, ...authorizedUnknown, ...pair };
        expect(final?.properties).toMatchObject(expected);
        expect(unknownKeys(final!.properties)).toHaveLength(2);
        const enriched = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: {
            ...final!.properties,
            $current_url: "PRIVATE URL",
            message: stopMessage,
          },
          $set: { email: "PRIVATE" },
          $set_once: { email: "PRIVATE" },
        });
        expect(enriched.properties).toMatchObject(expected);
        expect(unknownKeys(enriched.properties)).toHaveLength(2);
        // Unrelated normal fields still pass the existing allowlist.
        expect(enriched.properties).toMatchObject({
          commandId: "command",
          connectionId: "connection",
          outcome: "acknowledged",
        });
        expect(enriched).not.toHaveProperty("$set");
        expect(enriched).not.toHaveProperty("$set_once");
        const serialized = JSON.stringify([final, enriched]);
        expect(serialized).not.toContain("PRIVATE");
        expect(serialized).not.toContain("confirm an earlier command");
      },
    );

    it("keeps an unsampled unknown pair at the diagnostic rate under the same key", () => {
      jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: authorizedUnknown,
        invocationUnknown: unknown,
      });
      expect(final).toMatchObject({
        dedupeKey: JSON.stringify(["connection", "command"]),
        properties: {
          ...authorizedUnknown,
          ...unknown,
          telemetry_sampled: false,
          telemetry_sample_rate: 1,
        },
      });
      expect(capture.mock.calls.map(([event]) => event.event)).not.toContain(
        "desktop_ack_command_started",
      );
    });

    it.each<[string, Record<string, unknown>]>([
      ["a missing version", { desktop_invocation_unknown_version: undefined }],
      ["a string version", { desktop_invocation_unknown_version: "1" }],
      ["an unsupported version", { desktop_invocation_unknown_version: 2 }],
      ["a missing class", { desktop_invocation_unknown_class: undefined }],
      ["a private class", { desktop_invocation_unknown_class: "PRIVATE" }],
      ["the coarse reason", { desktop_invocation_unknown_class: "unknown" }],
      [
        "a raw lifecycle message",
        { desktop_invocation_unknown_class: stopMessage },
      ],
    ])("drops only the unknown pair for %s", (_case, change) => {
      const invalid = { ...unknown, ...change };
      const final = settle({
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: authorizedUnknown,
        invocationUnknown: invalid,
      });
      expect(final?.properties).toMatchObject({
        ...rejectedKind,
        ...authorizedUnknown,
      });
      expect(unknownKeys(final!.properties)).toEqual([]);
      expect(
        sanitize({
          terminalType: "error",
          ...rejectedKind,
          ...authorizedUnknown,
          ...invalid,
        }),
      ).toEqual({
        terminalType: "error",
        ...rejectedKind,
        ...authorizedUnknown,
      });
      expect(JSON.stringify(final)).not.toContain("PRIVATE");
      expect(JSON.stringify(final)).not.toContain("confirm an earlier");
    });

    it.each<[string, Record<string, unknown>]>([
      ["another class", { invocationRejection: rejection }],
      [
        "an authorized spawn class",
        {
          invocationRejection: {
            ...rejection,
            desktop_invocation_rejection_reason: "spawn_failed",
          },
        },
      ],
      [
        "an authorized admission class",
        {
          invocationRejection: {
            ...rejection,
            desktop_invocation_rejection_reason: "execution_admission",
          },
        },
      ],
      [
        "a compatibility unknown class",
        {
          invocationRejection: {
            ...authorizedUnknown,
            desktop_invocation_rejection_adapter: "compatibility_native",
          },
        },
      ],
      [
        "a published legacy unknown class",
        {
          invocationRejection: {
            ...authorizedUnknown,
            desktop_invocation_rejection_adapter: "published_legacy_native",
          },
        },
      ],
      [
        "an unselected unknown class",
        {
          invocationRejection: {
            ...authorizedUnknown,
            desktop_invocation_rejection_adapter: "not_selected",
          },
        },
      ],
      [
        "an invalid class",
        {
          invocationRejection: {
            ...authorizedUnknown,
            desktop_invocation_rejection_version: "1",
          },
        },
      ],
      ["no class", { invocationRejection: undefined }],
      [
        "a native timeout kind",
        {
          terminalError: {
            ...rejectedKind,
            desktop_terminal_error_kind: "native_command_timeout",
          },
        },
      ],
      ["no kind", { terminalError: undefined }],
      ["an exit", { terminalType: "exit", terminalExitCode: 0 }],
    ])("never attaches the unknown pair to %s", (_case, change) => {
      const settlement = {
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: authorizedUnknown,
        invocationUnknown: unknown,
        ...change,
      };
      const final = settle(settlement);
      expect(unknownKeys(final!.properties)).toEqual([]);
      const {
        terminalError: kind,
        invocationRejection,
        invocationUnknown,
        ...rest
      } = settlement;
      const sanitized = sanitize({
        ...rest,
        ...(kind as object),
        ...(invocationRejection as object),
        ...(invocationUnknown as object),
      });
      expect(unknownKeys(sanitized)).toEqual([]);
      // The coarse class is unaffected by the pair it did not admit.
      expect(rejectionKeys(sanitized)).toEqual(
        rejectionKeys(final!.properties),
      );
    });

    it("never attaches the unknown pair to a start or summary", () => {
      for (const event of [
        "desktop_ack_command_started",
        "desktop_ack_delivery_summary",
      ])
        expect(
          unknownKeys(
            sanitizeDesktopAckEvent({
              event,
              properties: {
                terminalType: "error",
                ...rejectedKind,
                ...authorizedUnknown,
                ...unknown,
              },
            }).properties,
          ),
        ).toEqual([]);
    });

    it("strips hostile unknown keys before any value access at capture or before_send", () => {
      let reads = 0;
      const withAccessors = (target: Record<string, unknown>) => {
        for (const key of DESKTOP_INVOCATION_UNKNOWN_PROPERTIES)
          Object.defineProperty(target, key, {
            enumerable: true,
            get() {
              reads++;
              return key.endsWith("version") ? 1 : "lifecycle_page_replaced";
            },
          });
        return target;
      };
      const fail = () => {
        throw new Error("PRIVATE");
      };
      for (const invocationUnknown of [
        withAccessors({}),
        new Proxy(
          { ...unknown },
          { get: fail, getOwnPropertyDescriptor: fail },
        ),
      ]) {
        const final = settle({
          ...terminalError,
          terminalError: rejectedKind,
          invocationRejection: authorizedUnknown,
          invocationUnknown,
        });
        expect(final?.properties).toMatchObject(authorizedUnknown);
        expect(unknownKeys(final!.properties)).toEqual([]);
      }
      // Both inside and outside the gate, a raw key is never read or kept.
      for (const coarse of [authorizedUnknown, rejection]) {
        const sanitized = sanitizeDesktopAckEvent({
          event: "desktop_ack_command_settled",
          properties: withAccessors({
            terminalType: "error",
            ...rejectedKind,
            ...coarse,
          }),
        }).properties!;
        expect(sanitized).toEqual({
          terminalType: "error",
          ...rejectedKind,
          ...coarse,
        });
      }
      // An inherited pair is not the event's own data.
      const inherited = Object.assign(Object.create(unknown as object), {
        terminalType: "error",
        ...rejectedKind,
        ...authorizedUnknown,
      }) as Record<string, unknown>;
      expect(
        unknownKeys(
          sanitizeDesktopAckEvent({
            event: "desktop_ack_command_settled",
            properties: inherited,
          }).properties,
        ),
      ).toEqual([]);
      expect(reads).toBe(0);
    });

    it.each<[string, string | null]>([
      ["an owner change", "another-user"],
      ["withdrawn consent", null],
    ])(
      "never emits the unknown pair after %s before settlement",
      (_case, next) => {
        capture.mockClear();
        const settleFinal = telemetry.start({
          connectionId: "connection",
          commandId: "command",
        });
        identity.mockReturnValue(next);
        settleFinal({
          ...terminalError,
          terminalError: rejectedKind,
          invocationRejection: authorizedUnknown,
          invocationUnknown: unknown,
        } as never);
        expect(
          capture.mock.calls.filter(
            ([event]) => event.event === "desktop_ack_command_settled",
          ),
        ).toEqual([]);
        expect(JSON.stringify(capture.mock.calls)).not.toContain(
          "desktop_invocation_unknown",
        );
      },
    );

    describe("stream fence origin", () => {
      const fence: DesktopStreamFenceDiagnostic = {
        desktop_stream_fence_version: 1,
        desktop_stream_fence_origin: "owner_process_error",
      };
      const fenceKeys = (properties: Record<string, unknown> = {}) =>
        Object.keys(properties).filter((key) =>
          DESKTOP_STREAM_FENCE_PROPERTIES.has(key),
        );
      const fenced = {
        ...terminalError,
        terminalError: rejectedKind,
        invocationRejection: authorizedUnknown,
        invocationUnknown: unknown,
        streamFence: fence,
      };
      const stopOrigin = {
        desktop_stream_fence_version: 1,
        desktop_stream_fence_origin: "owner_stop_requested",
      } as const;
      const cleanup = {
        desktop_stream_fence_cleanup_version: 1,
        desktop_stream_fence_cleanup_failure: "leader_wait_timed_out",
      } as const;
      const stopFence: DesktopStreamFenceDiagnostic = {
        ...stopOrigin,
        ...cleanup,
      };

      it("keeps an unsampled group beside the unknown pair through capture and before_send", () => {
        jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
        const final = settle({
          ...fenced,
          // Private extras on the same carrier never survive the copy.
          streamFence: { ...fence, pid: 4242, message: "PRIVATE" },
        });
        const expected = {
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
          ...fence,
        };
        // Sampling is unchanged: the diagnostic final keeps its rate and key.
        expect(final).toMatchObject({
          dedupeKey: JSON.stringify(["connection", "command"]),
          properties: {
            ...expected,
            telemetry_sampled: false,
            telemetry_sample_rate: 1,
          },
        });
        expect(fenceKeys(final!.properties)).toHaveLength(2);
        const enriched = sanitize({ ...final!.properties, pid: 4242 });
        expect(enriched).toMatchObject(expected);
        expect(fenceKeys(enriched)).toHaveLength(2);
        expect(enriched).not.toHaveProperty("pid");
        expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
      });

      it.each<[string, Record<string, unknown>]>([
        ["a missing version", { desktop_stream_fence_version: undefined }],
        ["a string version", { desktop_stream_fence_version: "1" }],
        ["an unsupported version", { desktop_stream_fence_version: 2 }],
        ["a missing origin", { desktop_stream_fence_origin: undefined }],
        ["a private origin", { desktop_stream_fence_origin: "PRIVATE" }],
        ["a numeric origin", { desktop_stream_fence_origin: 1 }],
      ])("drops only the fence group for %s", (_case, change) => {
        const invalid = { ...fence, ...change };
        const final = settle({ ...fenced, streamFence: invalid });
        expect(final?.properties).toMatchObject({
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
        });
        expect(fenceKeys(final!.properties)).toEqual([]);
        expect(
          sanitize({
            terminalType: "error",
            ...rejectedKind,
            ...authorizedUnknown,
            ...unknown,
            ...invalid,
          }),
        ).toEqual({
          terminalType: "error",
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
        });
      });

      it.each<[string, Record<string, unknown>]>([
        [
          "a page replacement class",
          {
            invocationUnknown: {
              ...unknown,
              desktop_invocation_unknown_class: "lifecycle_page_replaced",
            },
          },
        ],
        [
          "an other string class",
          {
            invocationUnknown: {
              ...unknown,
              desktop_invocation_unknown_class: "other_string",
            },
          },
        ],
        ["no unknown pair", { invocationUnknown: undefined }],
        [
          "a compatibility unknown class",
          {
            invocationRejection: {
              ...authorizedUnknown,
              desktop_invocation_rejection_adapter: "compatibility_native",
            },
          },
        ],
        [
          "a published legacy unknown class",
          {
            invocationRejection: {
              ...authorizedUnknown,
              desktop_invocation_rejection_adapter: "published_legacy_native",
            },
          },
        ],
        ["an approval rejection", { invocationRejection: rejection }],
        [
          "a native timeout kind",
          {
            terminalError: {
              ...rejectedKind,
              desktop_terminal_error_kind: "native_command_timeout",
            },
          },
        ],
        ["an exit", { terminalType: "exit", terminalExitCode: 1 }],
      ])("never attaches the group to %s", (_case, change) => {
        // Neither the origin pair nor a stop's cleanup pair.
        for (const carried of [fence, stopFence]) {
          const settlement = { ...fenced, streamFence: carried, ...change };
          const final = settle(settlement);
          expect(fenceKeys(final!.properties)).toEqual([]);
          const {
            terminalError: kind,
            invocationRejection,
            invocationUnknown,
            streamFence,
            ...rest
          } = settlement;
          const sanitized = sanitize({
            ...rest,
            ...(kind as object),
            ...(invocationRejection as object),
            ...(invocationUnknown as object),
            ...(streamFence as object),
          });
          expect(fenceKeys(sanitized)).toEqual([]);
        }
      });

      it("never attaches the group to a start or summary", () => {
        for (const event of [
          "desktop_ack_command_started",
          "desktop_ack_delivery_summary",
        ])
          expect(
            fenceKeys(
              sanitizeDesktopAckEvent({
                event,
                properties: {
                  terminalType: "error",
                  ...rejectedKind,
                  ...authorizedUnknown,
                  ...unknown,
                  ...fence,
                },
              }).properties,
            ),
          ).toEqual([]);
      });

      it("strips hostile fence keys before any value access at capture or before_send", () => {
        let reads = 0;
        const withAccessors = (target: Record<string, unknown>) => {
          for (const key of DESKTOP_STREAM_FENCE_PROPERTIES)
            Object.defineProperty(target, key, {
              enumerable: true,
              get() {
                reads++;
                return key.endsWith("version") ? 1 : "owner_timeout";
              },
            });
          return target;
        };
        const fail = () => {
          throw new Error("PRIVATE");
        };
        for (const streamFence of [
          withAccessors({}),
          new Proxy(
            { ...fence },
            { get: fail, getOwnPropertyDescriptor: fail },
          ),
        ]) {
          const final = settle({ ...fenced, streamFence });
          expect(final?.properties).toMatchObject(unknown);
          expect(fenceKeys(final!.properties)).toEqual([]);
        }
        // Both inside and outside the gate, a raw key is never read or kept.
        for (const pair of [
          unknown,
          { ...unknown, desktop_invocation_unknown_class: "other_string" },
        ]) {
          const sanitized = sanitizeDesktopAckEvent({
            event: "desktop_ack_command_settled",
            properties: withAccessors({
              terminalType: "error",
              ...rejectedKind,
              ...authorizedUnknown,
              ...pair,
            }),
          }).properties!;
          expect(sanitized).toEqual({
            terminalType: "error",
            ...rejectedKind,
            ...authorizedUnknown,
            ...pair,
          });
        }
        // An inherited group is not the event's own data.
        const inherited = Object.assign(Object.create(fence as object), {
          terminalType: "error",
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
        }) as Record<string, unknown>;
        expect(
          fenceKeys(
            sanitizeDesktopAckEvent({
              event: "desktop_ack_command_settled",
              properties: inherited,
            }).properties,
          ),
        ).toEqual([]);
        expect(reads).toBe(0);
      });

      describe("stop cleanup failure", () => {
        const failures = [
          "tree_unconfirmed",
          "leader_wait_timed_out",
          "leader_wait_failed",
          "tree_and_leader_wait_timed_out",
          "tree_and_leader_wait_failed",
        ] as const;
        const coarse = {
          terminalType: "error",
          terminalAcknowledged: true,
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
        };

        it.each(failures)(
          "keeps the unsampled %s pair beside its stop origin through capture and before_send",
          (failure) => {
            jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
            const expected = {
              ...stopOrigin,
              desktop_stream_fence_cleanup_version: 1,
              desktop_stream_fence_cleanup_failure: failure,
            };
            const final = settle({
              ...fenced,
              // Private extras on the same carrier never survive the copy.
              streamFence: { ...expected, pid: 4242, message: "PRIVATE" },
            });
            // Sampling is unchanged: the diagnostic final keeps its rate.
            expect(final?.properties).toMatchObject({
              ...rejectedKind,
              ...authorizedUnknown,
              ...unknown,
              ...expected,
              telemetry_sampled: false,
              telemetry_sample_rate: 1,
            });
            expect(fenceKeys(final!.properties)).toHaveLength(4);
            const enriched = sanitize({ ...final!.properties, pid: 4242 });
            expect(enriched).toMatchObject(expected);
            expect(fenceKeys(enriched)).toHaveLength(4);
            expect(enriched).not.toHaveProperty("pid");
            expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
          },
        );

        it.each<[string, Record<string, unknown>]>([
          ["no cleanup pair", {}],
          [
            "a missing version",
            { desktop_stream_fence_cleanup_failure: "tree_unconfirmed" },
          ],
          ["a missing failure", { desktop_stream_fence_cleanup_version: 1 }],
          [
            "a string version",
            { ...cleanup, desktop_stream_fence_cleanup_version: "1" },
          ],
          [
            "an unsupported version",
            { ...cleanup, desktop_stream_fence_cleanup_version: 2 },
          ],
          [
            "a private failure",
            { ...cleanup, desktop_stream_fence_cleanup_failure: "PRIVATE" },
          ],
          [
            "a numeric failure",
            { ...cleanup, desktop_stream_fence_cleanup_failure: 1 },
          ],
        ])("keeps exactly the origin pair for %s", (_case, carried) => {
          const final = settle({
            ...fenced,
            streamFence: { ...stopOrigin, ...carried },
          });
          expect(fenceKeys(final!.properties)).toEqual(Object.keys(stopOrigin));
          expect(final?.properties).toMatchObject(stopOrigin);
          expect(sanitize({ ...coarse, ...stopOrigin, ...carried })).toEqual({
            ...coarse,
            ...stopOrigin,
          });
        });

        // Cleanup keys as getters; the proxy also counts their descriptor
        // reads. An event's own keys are always enumerated by before_send, so
        // there only a getter run counts.
        const counted = (target: Record<string, unknown>) => {
          const reads = { count: 0 };
          for (const key of Object.keys(cleanup))
            Object.defineProperty(target, key, {
              enumerable: true,
              get() {
                reads.count++;
                return cleanup[key as keyof typeof cleanup];
              },
            });
          const proxy = new Proxy(target, {
            getOwnPropertyDescriptor(object, key) {
              if (typeof key === "string" && key in cleanup) reads.count++;
              return Reflect.getOwnPropertyDescriptor(object, key);
            },
          });
          return { target, proxy, reads };
        };

        it.each([
          "owner_timeout",
          "owner_process_error",
          "owner_delivery_failed",
          "owner_outcome_missing",
          "cancel_wait_timeout",
        ])(
          "never reads or keeps a cleanup pair beside the %s origin",
          (origin) => {
            const otherOrigin = {
              ...stopOrigin,
              desktop_stream_fence_origin: origin,
            };
            // A complete data pair beside it is still never kept.
            expect(
              fenceKeys(sanitize({ ...coarse, ...otherOrigin, ...cleanup })),
            ).toEqual(Object.keys(otherOrigin));
            const carrier = counted({ ...otherOrigin });
            const final = settle({ ...fenced, streamFence: carrier.proxy });
            expect(fenceKeys(final!.properties)).toEqual(
              Object.keys(otherOrigin),
            );
            expect(final?.properties).toMatchObject(otherOrigin);
            const event = counted({ ...coarse, ...otherOrigin });
            expect(
              sanitizeDesktopAckEvent({
                event: "desktop_ack_command_settled",
                properties: event.target,
              }).properties,
            ).toEqual({ ...coarse, ...otherOrigin });
            expect(carrier.reads.count + event.reads.count).toBe(0);
          },
        );

        it.each<[string, unknown]>([
          ["an unacknowledged terminal", false],
          ["a missing acknowledgement", undefined],
          ["a string acknowledgement", "true"],
        ])(
          "never reads or keeps the cleanup pair on %s",
          (_case, terminalAcknowledged) => {
            // A complete data pair is still never kept.
            expect(
              fenceKeys(
                sanitize({ ...coarse, terminalAcknowledged, ...stopFence }),
              ),
            ).toEqual(Object.keys(stopOrigin));
            const carrier = counted({ ...stopOrigin });
            const final = settle({
              ...fenced,
              outcome: "incomplete",
              reason: "deadline_exceeded",
              terminalAcknowledged,
              streamFence: carrier.proxy,
            });
            expect(final?.properties).toMatchObject(stopOrigin);
            expect(fenceKeys(final!.properties)).toEqual(
              Object.keys(stopOrigin),
            );
            const event = counted({
              ...coarse,
              terminalAcknowledged,
              ...stopOrigin,
            });
            expect(
              fenceKeys(
                sanitizeDesktopAckEvent({
                  event: "desktop_ack_command_settled",
                  properties: event.target,
                }).properties,
              ),
            ).toEqual(Object.keys(stopOrigin));
            expect(carrier.reads.count + event.reads.count).toBe(0);
          },
        );

        it("keeps the origin pair when the cleanup pair is hostile", () => {
          const fail = () => {
            throw new Error("PRIVATE");
          };
          let gets = 0;
          const accessors = { ...stopOrigin } as Record<string, unknown>;
          for (const key of Object.keys(cleanup))
            Object.defineProperty(accessors, key, {
              enumerable: true,
              get() {
                gets++;
                return cleanup[key as keyof typeof cleanup];
              },
            });
          // Throws only once a cleanup key is read, after the origin pair.
          const throwing = new Proxy(
            { ...stopOrigin, ...cleanup },
            {
              get: fail,
              getOwnPropertyDescriptor(target, key) {
                if (typeof key === "string" && key in cleanup) fail();
                return Reflect.getOwnPropertyDescriptor(target, key);
              },
            },
          );
          for (const streamFence of [accessors, throwing]) {
            const final = settle({ ...fenced, streamFence });
            expect(final?.properties).toMatchObject(stopOrigin);
            expect(fenceKeys(final!.properties)).toEqual(
              Object.keys(stopOrigin),
            );
          }
          const sanitized = sanitizeDesktopAckEvent({
            event: "desktop_ack_command_settled",
            properties: Object.defineProperties(
              { ...coarse, ...stopOrigin } as Record<string, unknown>,
              Object.getOwnPropertyDescriptors(accessors),
            ),
          }).properties;
          expect(sanitized).toEqual({ ...coarse, ...stopOrigin });
          expect(gets).toBe(0);
        });

        describe("Windows taskkill receipt", () => {
          const treePairs = {
            ...stopOrigin,
            desktop_stream_fence_cleanup_version: 1,
            desktop_stream_fence_cleanup_failure: "tree_unconfirmed",
          } as const;
          const taskkill = {
            desktop_stream_fence_windows_taskkill_version: 1,
            desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
            desktop_stream_fence_windows_taskkill_exit_code: -1,
          } as const;

          it("keeps the unsampled group beside its tree_unconfirmed pair through capture and before_send", () => {
            jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
            const expected = { ...treePairs, ...taskkill };
            const final = settle({
              ...fenced,
              // Private extras on the same carrier never survive the copy.
              streamFence: { ...expected, pid: 4242, stderr: "PRIVATE" },
            });
            expect(final?.properties).toMatchObject({
              ...expected,
              telemetry_sampled: false,
              telemetry_sample_rate: 1,
            });
            expect(fenceKeys(final!.properties)).toHaveLength(7);
            const enriched = sanitize({
              ...final!.properties,
              pid: 4242,
              command: "PRIVATE",
            });
            expect(enriched).toMatchObject(expected);
            expect(fenceKeys(enriched)).toHaveLength(7);
            expect(enriched).not.toHaveProperty("pid");
            expect(JSON.stringify([final, enriched])).not.toContain("PRIVATE");
          });

          it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
            [
              "a code beside output_error",
              treePairs,
              {
                ...taskkill,
                desktop_stream_fence_windows_taskkill_outcome: "output_error",
              },
            ],
            [
              "a zero code",
              treePairs,
              {
                ...taskkill,
                desktop_stream_fence_windows_taskkill_exit_code: 0,
              },
            ],
            [
              "a private outcome",
              treePairs,
              {
                ...taskkill,
                desktop_stream_fence_windows_taskkill_outcome: "PRIVATE",
              },
            ],
            [
              "another cleanup failure",
              {
                ...treePairs,
                desktop_stream_fence_cleanup_failure: "leader_wait_failed",
              },
              taskkill,
            ],
            [
              "a malformed cleanup pair",
              stopOrigin,
              {
                ...treePairs,
                ...taskkill,
                desktop_stream_fence_cleanup_version: 2,
              },
            ],
          ])("keeps exactly the prior pairs for %s", (_case, kept, carried) => {
            const final = settle({
              ...fenced,
              streamFence: { ...kept, ...carried },
            });
            expect(fenceKeys(final!.properties)).toEqual(Object.keys(kept));
            expect(final?.properties).toMatchObject(kept);
            expect(sanitize({ ...coarse, ...kept, ...carried })).toEqual({
              ...coarse,
              ...kept,
            });
          });

          describe("root report pair", () => {
            const withoutRoot = {
              ...taskkill,
              desktop_stream_fence_windows_taskkill_exit_code: 128,
            } as const;
            const root = {
              desktop_stream_fence_windows_taskkill_root_report_version: 1,
              desktop_stream_fence_windows_taskkill_root_report:
                "requested_pid_not_found",
            } as const;
            const notFound = { ...withoutRoot, ...root } as const;

            it("keeps the unsampled pair beside its code through capture and before_send", () => {
              jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
              const expected = { ...treePairs, ...notFound };
              const final = settle({
                ...fenced,
                streamFence: {
                  ...expected,
                  stderr: 'ERROR: The process "PRIVATE" not found.',
                  pid: 4242,
                },
              });
              expect(final?.properties).toMatchObject({
                ...expected,
                telemetry_sample_rate: 1,
              });
              expect(fenceKeys(final!.properties)).toHaveLength(9);
              const enriched = sanitize({
                ...final!.properties,
                pid: 4242,
                command: "PRIVATE",
              });
              expect(enriched).toMatchObject(expected);
              expect(fenceKeys(enriched)).toHaveLength(9);
              expect(final!.properties).not.toHaveProperty("pid");
              expect(enriched).not.toHaveProperty("pid");
              expect(JSON.stringify([final, enriched])).not.toContain(
                "PRIVATE",
              );
            });

            it.each<[string, Record<string, unknown>]>([
              [
                "not found beside exit 255",
                {
                  ...notFound,
                  desktop_stream_fence_windows_taskkill_exit_code: 255,
                },
              ],
              [
                "a private report",
                {
                  ...notFound,
                  desktop_stream_fence_windows_taskkill_root_report: "PRIVATE",
                },
              ],
              [
                "an unsupported version",
                {
                  ...notFound,
                  desktop_stream_fence_windows_taskkill_root_report_version: 2,
                },
              ],
            ])("drops only the pair for %s", (_case, carried) => {
              const kept = {
                ...treePairs,
                ...withoutRoot,
                desktop_stream_fence_windows_taskkill_exit_code:
                  carried.desktop_stream_fence_windows_taskkill_exit_code,
              };
              const final = settle({
                ...fenced,
                streamFence: { ...treePairs, ...carried },
              });
              expect(fenceKeys(final!.properties)).toEqual(Object.keys(kept));
              expect(final?.properties).toMatchObject(kept);
              expect(sanitize({ ...coarse, ...treePairs, ...carried })).toEqual(
                { ...coarse, ...kept },
              );
            });

            it("never keeps the pair without a code or on an unacknowledged terminal", () => {
              const codeless = {
                desktop_stream_fence_windows_taskkill_version: 1,
                desktop_stream_fence_windows_taskkill_outcome: "nonzero_exit",
              };
              expect(
                sanitize({ ...coarse, ...treePairs, ...codeless, ...root }),
              ).toEqual({
                ...coarse,
                ...treePairs,
                ...codeless,
              });
              expect(
                fenceKeys(
                  sanitize({
                    ...coarse,
                    terminalAcknowledged: false,
                    ...treePairs,
                    ...notFound,
                  }),
                ),
              ).toEqual(Object.keys(stopOrigin));
            });

            describe("stop request source pair", () => {
              const sourcePair = {
                desktop_stream_fence_stop_request_source_version: 1,
                desktop_stream_fence_stop_request_source: "cancel_ipc",
              } as const;
              const reported = { ...treePairs, ...notFound } as const;
              // The same exit 128 with an unclassified report.
              const unclassified = {
                ...reported,
                desktop_stream_fence_windows_taskkill_root_report:
                  "unclassified",
              } as const;

              it.each(
                ["cancel_ipc", "document_invalidation", "application_exit"]
                  .flatMap((source) =>
                    [reported, unclassified].map(
                      (report) => [source, report] as const,
                    ),
                  )
                  .map(
                    ([source, report]) =>
                      [
                        source,
                        report.desktop_stream_fence_windows_taskkill_root_report,
                        report,
                      ] as const,
                  ),
              )(
                "keeps the unsampled %s pair beside its exit 128 %s report through capture and before_send",
                (source, _class, report) => {
                  jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
                  const expected = {
                    ...report,
                    desktop_stream_fence_stop_request_source_version: 1,
                    desktop_stream_fence_stop_request_source: source,
                  };
                  const final = settle({
                    ...fenced,
                    // Private extras on the same carrier never survive.
                    streamFence: {
                      ...expected,
                      pid: 4242,
                      cwd: "C:\\Users\\PRIVATE",
                      elapsedMs: 987_654_321,
                    },
                  });
                  expect(final?.properties).toMatchObject({
                    ...expected,
                    telemetry_sample_rate: 1,
                  });
                  expect(fenceKeys(final!.properties)).toEqual(
                    Object.keys(expected),
                  );
                  const enriched = sanitize({
                    ...final!.properties,
                    pid: 4242,
                    command: "PRIVATE",
                  });
                  expect(enriched).toMatchObject(expected);
                  expect(fenceKeys(enriched)).toEqual(Object.keys(expected));
                  expect(enriched).not.toHaveProperty("pid");
                  const serialized = JSON.stringify([final, enriched]);
                  expect(serialized).not.toContain("PRIVATE");
                  expect(serialized).not.toContain("987654321");
                },
              );

              it.each<[string, Record<string, unknown>]>([
                [
                  "a human action",
                  {
                    ...sourcePair,
                    desktop_stream_fence_stop_request_source:
                      "user_clicked_stop",
                  },
                ],
                [
                  "a private source",
                  {
                    ...sourcePair,
                    desktop_stream_fence_stop_request_source: "PRIVATE",
                  },
                ],
                [
                  "an unsupported version",
                  {
                    ...sourcePair,
                    desktop_stream_fence_stop_request_source_version: 2,
                  },
                ],
                [
                  "a missing version",
                  { desktop_stream_fence_stop_request_source: "cancel_ipc" },
                ],
                [
                  "a missing source",
                  { desktop_stream_fence_stop_request_source_version: 1 },
                ],
              ])("drops only the source pair for %s", (_case, carried) => {
                for (const report of [reported, unclassified]) {
                  const final = settle({
                    ...fenced,
                    streamFence: { ...report, ...carried },
                  });
                  expect(fenceKeys(final!.properties)).toEqual(
                    Object.keys(report),
                  );
                  expect(final?.properties).toMatchObject(report);
                  expect(
                    sanitize({ ...coarse, ...report, ...carried }),
                  ).toEqual({ ...coarse, ...report });
                }
              });

              it.each<[string, Record<string, unknown>]>([
                [
                  "an unclassified exit 255 report",
                  {
                    ...unclassified,
                    desktop_stream_fence_windows_taskkill_exit_code: 255,
                  },
                ],
                ["a code without a report", { ...treePairs, ...withoutRoot }],
                [
                  "a not-found report beside exit 255",
                  {
                    ...reported,
                    desktop_stream_fence_windows_taskkill_exit_code: 255,
                  },
                ],
                [
                  "another cleanup failure",
                  {
                    ...reported,
                    desktop_stream_fence_cleanup_failure: "leader_wait_failed",
                  },
                ],
              ])(
                "never reads or keeps the source pair beside %s",
                (_case, carried) => {
                  const kept = sanitize({ ...coarse, ...carried });
                  expect(fenceKeys(kept)).not.toContain(
                    "desktop_stream_fence_stop_request_source",
                  );
                  let reads = 0;
                  const carrier = new Proxy(
                    { ...carried, ...sourcePair },
                    {
                      getOwnPropertyDescriptor(target, key) {
                        if (typeof key === "string" && key in sourcePair)
                          reads++;
                        return Reflect.getOwnPropertyDescriptor(target, key);
                      },
                    },
                  );
                  const final = settle({ ...fenced, streamFence: carrier });
                  expect(fenceKeys(final!.properties)).toEqual(fenceKeys(kept));
                  expect(
                    sanitize({ ...coarse, ...carried, ...sourcePair }),
                  ).toEqual(kept);
                  expect(reads).toBe(0);
                },
              );

              it("never keeps the pair on an unacknowledged terminal", () => {
                const final = settle({
                  ...fenced,
                  outcome: "incomplete",
                  reason: "deadline_exceeded",
                  terminalAcknowledged: false,
                  streamFence: { ...reported, ...sourcePair },
                });
                expect(fenceKeys(final!.properties)).toEqual(
                  Object.keys(stopOrigin),
                );
                expect(
                  fenceKeys(
                    sanitize({
                      ...coarse,
                      terminalAcknowledged: false,
                      ...reported,
                      ...sourcePair,
                    }),
                  ),
                ).toEqual(Object.keys(stopOrigin));
              });
            });
          });

          it("never keeps the group on an unacknowledged terminal", () => {
            const final = settle({
              ...fenced,
              outcome: "incomplete",
              reason: "deadline_exceeded",
              terminalAcknowledged: false,
              streamFence: { ...treePairs, ...taskkill },
            });
            expect(fenceKeys(final!.properties)).toEqual(
              Object.keys(stopOrigin),
            );
            expect(
              fenceKeys(
                sanitize({
                  ...coarse,
                  terminalAcknowledged: false,
                  ...treePairs,
                  ...taskkill,
                }),
              ),
            ).toEqual(Object.keys(stopOrigin));
          });

          describe("final acknowledgement projection", () => {
            // The coarse fields without the flag; each case supplies its own.
            const unflagged = Object.fromEntries(
              Object.entries(coarse).filter(
                ([key]) => key !== "terminalAcknowledged",
              ),
            );
            const project = (properties: Record<string, unknown>) =>
              sanitizeDesktopAckEvent({
                event: "desktop_ack_command_settled",
                properties,
              }).properties!;

            it.each([true, false])(
              "keeps an ordinary own %s flag and joins only its groups",
              (flag) => {
                expect(
                  project({
                    ...unflagged,
                    terminalAcknowledged: flag,
                    ...treePairs,
                    ...taskkill,
                  }),
                ).toEqual({
                  ...unflagged,
                  terminalAcknowledged: flag,
                  ...(flag ? { ...treePairs, ...taskkill } : stopOrigin),
                });
              },
            );

            it.each<[string, () => Record<string, unknown>]>([
              [
                "an inherited",
                () =>
                  Object.assign(Object.create({ terminalAcknowledged: true }), {
                    ...unflagged,
                    ...treePairs,
                    ...taskkill,
                  }),
              ],
              [
                "a non-enumerable",
                () =>
                  Object.defineProperty(
                    { ...unflagged, ...treePairs, ...taskkill },
                    "terminalAcknowledged",
                    { value: true, enumerable: false },
                  ),
              ],
            ])(
              "omits %s true flag and keeps exactly the origin pair",
              (_case, properties) => {
                const projected = project(properties());
                expect(projected).toEqual({ ...unflagged, ...stopOrigin });
                expect(projected).not.toHaveProperty("terminalAcknowledged");
              },
            );

            it("never runs an accessor true flag and omits it with both receipts", () => {
              let gets = 0;
              const accessor = Object.defineProperty(
                { ...unflagged, ...treePairs, ...taskkill },
                "terminalAcknowledged",
                {
                  enumerable: true,
                  get() {
                    gets++;
                    return true;
                  },
                },
              );
              const projected = project(accessor);
              expect(projected).toEqual({ ...unflagged, ...stopOrigin });
              expect(projected).not.toHaveProperty("terminalAcknowledged");
              expect(gets).toBe(0);
            });
          });
        });
      });

      describe("cancel wait owner phase", () => {
        const timedOut = {
          desktop_stream_fence_version: 1,
          desktop_stream_fence_origin: "cancel_wait_timeout",
        } as const;
        const phasePair = {
          desktop_stream_fence_cancel_wait_owner_phase_version: 1,
          desktop_stream_fence_cancel_wait_owner_phase: "owner_streaming",
        } as const;
        const coarse = {
          terminalType: "error",
          terminalAcknowledged: true,
          ...rejectedKind,
          ...authorizedUnknown,
          ...unknown,
        };

        it.each([
          "owner_pending",
          "owner_streaming",
          "stop_cleanup_tree_and_leader_pending",
          "stop_cleanup_tree_pending",
          "stop_cleanup_leader_pending",
          "owner_cleanup",
          "terminal_delivery",
          "released",
        ])(
          "keeps the unsampled %s pair beside its timeout origin through capture and before_send",
          (phase) => {
            jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
            const expected = {
              ...timedOut,
              desktop_stream_fence_cancel_wait_owner_phase_version: 1,
              desktop_stream_fence_cancel_wait_owner_phase: phase,
            };
            const final = settle({
              ...fenced,
              // Private extras on the same carrier never survive the copy.
              streamFence: { ...expected, pid: 4242, elapsedMs: 987_654_321 },
            });
            expect(final?.properties).toMatchObject({
              ...unknown,
              ...expected,
              telemetry_sampled: false,
              telemetry_sample_rate: 1,
            });
            expect(fenceKeys(final!.properties)).toEqual(Object.keys(expected));
            const enriched = sanitize({ ...final!.properties, pid: 4242 });
            expect(enriched).toMatchObject(expected);
            expect(fenceKeys(enriched)).toEqual(Object.keys(expected));
            expect(enriched).not.toHaveProperty("pid");
            expect(JSON.stringify([final, enriched])).not.toContain(
              "987654321",
            );
          },
        );

        it.each<[string, Record<string, unknown>]>([
          ["no phase pair", {}],
          [
            "a missing version",
            {
              desktop_stream_fence_cancel_wait_owner_phase: "owner_streaming",
            },
          ],
          [
            "a missing phase",
            { desktop_stream_fence_cancel_wait_owner_phase_version: 1 },
          ],
          [
            "a string version",
            {
              ...phasePair,
              desktop_stream_fence_cancel_wait_owner_phase_version: "1",
            },
          ],
          [
            "an unsupported version",
            {
              ...phasePair,
              desktop_stream_fence_cancel_wait_owner_phase_version: 2,
            },
          ],
          [
            "a private phase",
            {
              ...phasePair,
              desktop_stream_fence_cancel_wait_owner_phase: "PRIVATE",
            },
          ],
        ])("keeps exactly the origin pair for %s", (_case, carried) => {
          const final = settle({
            ...fenced,
            streamFence: { ...timedOut, ...carried },
          });
          expect(fenceKeys(final!.properties)).toEqual(Object.keys(timedOut));
          expect(sanitize({ ...coarse, ...timedOut, ...carried })).toEqual({
            ...coarse,
            ...timedOut,
          });
        });

        // Phase keys as getters; the proxy also counts their descriptor reads.
        const counted = (target: Record<string, unknown>) => {
          const reads = { count: 0 };
          for (const key of Object.keys(phasePair))
            Object.defineProperty(target, key, {
              enumerable: true,
              get() {
                reads.count++;
                return phasePair[key as keyof typeof phasePair];
              },
            });
          const proxy = new Proxy(target, {
            getOwnPropertyDescriptor(object, key) {
              if (typeof key === "string" && key in phasePair) reads.count++;
              return Reflect.getOwnPropertyDescriptor(object, key);
            },
          });
          return { target, proxy, reads };
        };

        it.each([
          "owner_timeout",
          "owner_process_error",
          "owner_stop_requested",
          "owner_delivery_failed",
          "owner_outcome_missing",
        ])(
          "never reads or keeps a phase pair beside the %s origin",
          (origin) => {
            const otherOrigin = {
              ...timedOut,
              desktop_stream_fence_origin: origin,
            };
            expect(
              fenceKeys(sanitize({ ...coarse, ...otherOrigin, ...phasePair })),
            ).toEqual(Object.keys(otherOrigin));
            const carrier = counted({ ...otherOrigin });
            const final = settle({ ...fenced, streamFence: carrier.proxy });
            expect(fenceKeys(final!.properties)).toEqual(
              Object.keys(otherOrigin),
            );
            const event = counted({ ...coarse, ...otherOrigin });
            expect(
              sanitizeDesktopAckEvent({
                event: "desktop_ack_command_settled",
                properties: event.target,
              }).properties,
            ).toEqual({ ...coarse, ...otherOrigin });
            expect(carrier.reads.count + event.reads.count).toBe(0);
          },
        );

        it.each<[string, unknown]>([
          ["an unacknowledged terminal", false],
          ["a missing acknowledgement", undefined],
          ["a string acknowledgement", "true"],
        ])(
          "never reads or keeps the phase pair on %s",
          (_case, terminalAcknowledged) => {
            expect(
              fenceKeys(
                sanitize({
                  ...coarse,
                  terminalAcknowledged,
                  ...timedOut,
                  ...phasePair,
                }),
              ),
            ).toEqual(Object.keys(timedOut));
            const carrier = counted({ ...timedOut });
            const final = settle({
              ...fenced,
              terminalAcknowledged,
              streamFence: carrier.proxy,
            });
            expect(fenceKeys(final!.properties)).toEqual(Object.keys(timedOut));
            expect(carrier.reads.count).toBe(0);
          },
        );
      });
    });
  });
});

describe("volume reduction and reliability counters", () => {
  const routine = {
    ...result,
    publishAttempts: 2,
    replayAttempts: 0,
    resumeRequests: 0,
  };
  const start = (commandId: string) =>
    telemetry.start({ connectionId: "connection", commandId });
  const summaries = () =>
    capture.mock.calls.filter(
      ([event]) => event.event === "desktop_ack_delivery_summary",
    );

  beforeEach(() => {
    jest.useFakeTimers();
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
  });

  it("replaces 2000 routine events with one unsampled summary and counts each command once", () => {
    for (let index = 0; index < 1000; index++) {
      const settle = start(`command-${index}`);
      settle(routine);
      settle(routine);
    }
    expect(capture).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(capture).toHaveBeenCalledTimes(1);
    expect(summaries()[0][0].properties).toMatchObject({
      schemaVersion: 2,
      startedCount: 1000,
      settledCount: 1000,
      acknowledgedCount: 1000,
      incompleteCount: 0,
      canceledCount: 0,
      pendingAtStart: 0,
      pendingAtEnd: 0,
      telemetry_sample_rate: 1,
    });
    jest.advanceTimersByTime(120_000);
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it.each(["start", "settle"])(
    "starts an empty window at its first %s after idle time",
    (activity) => {
      jest.setSystemTime(new Date("2026-10-29T00:00:00Z"));
      const settle = start("first");
      if (activity === "start") settle(routine);
      telemetry.flush();
      jest.advanceTimersByTime(2 * 60 * 60 * 1000);
      const activityTime = new Date().toISOString();
      if (activity === "start") start("second")(routine);
      else settle(routine);
      jest.advanceTimersByTime(30_000);
      if (activity === "start") start("third")(routine);
      telemetry.flush();
      const last = summaries().at(-1)![0].properties;
      expect(last).toMatchObject({
        windowStartedAt: activityTime,
        windowEndedAt: new Date().toISOString(),
        pendingAtStart: activity === "start" ? 0 : 1,
        pendingAtEnd: 0,
      });
    },
  );

  it("keeps pending starts across windows without counting them as success", () => {
    const settle = start("long-running");
    jest.advanceTimersByTime(60_000);
    settle(routine);
    telemetry.flush();
    expect(summaries().map(([{ properties }]) => properties)).toEqual([
      expect.objectContaining({
        windowSequence: 0,
        startedCount: 1,
        settledCount: 0,
        pendingAtStart: 0,
        pendingAtEnd: 1,
      }),
      expect.objectContaining({
        windowSequence: 1,
        startedCount: 0,
        settledCount: 1,
        pendingAtStart: 1,
        pendingAtEnd: 0,
      }),
    ]);
    expect(summaries()[0][0].dedupeKey).not.toBe(summaries()[1][0].dedupeKey);
  });

  it.each([
    { outcome: "incomplete", reason: "buffer_limit" },
    { outcome: "incomplete", reason: "deadline_exceeded" },
    { outcome: "incomplete", reason: "ownership_lost" },
    { outcome: "incomplete", reason: "stopped" },
    { outcome: "canceled", reason: "canceled" },
    { terminalType: "error" },
    { terminalExitCode: 1 },
    { terminalExitCode: null },
    { replayAttempts: 1 },
    { publishFailures: 1 },
    { resumeRequests: 1 },
    { durationMs: 30_000 },
  ])("keeps unsampled diagnostic details: %p", (change) => {
    start("diagnostic")({ ...routine, ...change } as typeof result);
    const details = capture.mock.calls.filter(
      ([event]) => event.event === "desktop_ack_command_settled",
    );
    expect(details).toHaveLength(1);
    expect(details[0][0].properties).toMatchObject({
      ...change,
      telemetry_sampled: false,
      telemetry_sample_rate: 1,
    });
    expect(
      capture.mock.calls.some(
        ([event]) => event.event === "desktop_ack_command_started",
      ),
    ).toBe(false);
  });

  it("preserves all-command and retry-evidence delivery rates independently of sampled details", () => {
    start("routine")(routine);
    start("replayed")(result);
    start("incomplete")({
      ...routine,
      outcome: "incomplete",
      reason: "deadline_exceeded",
      publishFailures: 2,
    });
    start("canceled")({ ...routine, outcome: "canceled", reason: "canceled" });
    start("error")({ ...routine, terminalType: "error" });
    start("nonzero")({ ...routine, terminalExitCode: 1 });
    start("pending");
    telemetry.flush();
    expect(summaries()[0][0].properties).toMatchObject({
      startedCount: 7,
      settledCount: 6,
      acknowledgedCount: 4,
      canceledCount: 1,
      incompleteCount: 1,
      terminalErrorCount: 1,
      nonzeroExitCount: 1,
      retryEvidenceCount: 2,
      retryEvidenceAcknowledgedCount: 1,
      deadlineExceededCount: 1,
      publishFailureCount: 2,
      replayCount: 1,
      resumeCount: 1,
      pendingAtEnd: 1,
    });
  });

  it("does not lose counters on same-user confirmation and discards them on consent withdrawal", () => {
    const oldFinal = start("old");
    const notify = jest
      .mocked(subscribeAuthenticatedAnalytics)
      .mock.calls.at(-1)![0];
    notify();
    identity.mockReturnValue(null);
    notify();
    identity.mockReturnValue("original-user");
    oldFinal(routine);
    start("new")(routine);
    telemetry.flush();
    expect(summaries()).toHaveLength(1);
    expect(summaries()[0][0].properties).toMatchObject({
      startedCount: 1,
      settledCount: 1,
    });
  });

  it("flushes on pagehide and stop, and releases timers and listeners", () => {
    start("hidden")(routine);
    window.dispatchEvent(new Event("pagehide"));
    expect(summaries()).toHaveLength(1);
    start("stopped")(
      { ...routine, outcome: "incomplete", reason: "stopped" },
      "bridge_stop",
    );
    telemetry.dispose();
    expect(summaries()).toHaveLength(2);
    expect(summaries()[1][0].properties).toMatchObject({
      incompleteCount: 1,
      stoppedCount: 1,
    });
    window.dispatchEvent(new Event("pagehide"));
    jest.advanceTimersByTime(60_000);
    expect(summaries()).toHaveLength(2);
    expect(jest.getTimerCount()).toBe(0);
  });

  it("retains counters across capture failure and never resends a successful summary", () => {
    capture.mockReturnValue(false);
    start("first")(routine);
    telemetry.flush();
    start("second")(routine);
    capture.mockReturnValue(true);
    telemetry.flush();
    expect(summaries().at(-1)![0].properties).toMatchObject({
      startedCount: 2,
      settledCount: 2,
    });
    expect(summaries()[0][0].dedupeKey).toBe(summaries()[1][0].dedupeKey);
    telemetry.flush();
    expect(summaries()).toHaveLength(2);
  });

  it("allowlists SDK-enriched summaries without command, URL or person content", () => {
    start("PRIVATE")(routine);
    telemetry.flush();
    const summary = summaries()[0][0];
    const enriched = sanitizeDesktopAckEvent({
      event: summary.event,
      properties: {
        ...summary.properties,
        commandId: "PRIVATE",
        chatId: "PRIVATE",
        $current_url: "PRIVATE",
        $set: { data: "PRIVATE" },
      },
      $set: { data: "PRIVATE" },
      $set_once: { data: "PRIVATE" },
    });
    expect(enriched.properties).toMatchObject({
      startedCount: 1,
      acknowledgedCount: 1,
      windowSequence: 0,
    });
    expect(JSON.stringify(enriched)).not.toContain("PRIVATE");
  });
});

describe("Desktop runtime identity at the capture and before_send boundaries", () => {
  const measured = {
    native_app_version: "0.0.74",
    native_platform: "windows",
    hackerai_frontend_build_commit: "a".repeat(40),
  };
  // Mirrors the production order: manual capture, SDK projection, then final.
  const send = (event: string, properties: Record<string, unknown>) =>
    applyDesktopRuntimeIdentity(
      sanitizeDesktopAckEvent({
        event,
        properties: {
          ...withDesktopRuntimeIdentity(event, properties),
          $current_url: "PRIVATE",
        },
      }),
    ).properties!;

  beforeAll(async () => {
    Object.defineProperty(window, "__TAURI_INTERNALS__", {
      configurable: true,
      value: {},
    });
    Object.defineProperty(window, "__TAURI_OS_PLUGIN_INTERNALS__", {
      configurable: true,
      value: { platform: "windows" },
    });
    await startDesktopRuntimeIdentityLookup();
  });

  afterAll(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    delete (window as { __TAURI_OS_PLUGIN_INTERNALS__?: unknown })
      .__TAURI_OS_PLUGIN_INTERNALS__;
  });

  it("drops an invalid receipt before shared identity can make it look valid", () => {
    const sent = send("desktop_ack_command_settled", {
      terminalType: "error",
      native_authorization_diagnostic_version: 1,
      native_authorization_send_timeout: true,
      native_authorization_send_connect: false,
      native_authorization_send_request: false,
      native_authorization_send_elapsed_ms: 500,
      native_authorization_origin_class: "canonical_production",
      native_app_version: "PRIVATE",
      native_platform: "darwin",
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "connection_reset",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    });
    expect(sent).toMatchObject(measured);
    expect(
      Object.keys(sent).filter((key) =>
        key.startsWith("native_authorization_"),
      ),
    ).toEqual([]);
  });

  it("keeps the same-invocation receipt group intact on a terminal-error final", () => {
    const receipt: NativeAuthorizationDiagnostic = {
      native_authorization_diagnostic_version: 1,
      native_authorization_send_timeout: true,
      native_authorization_send_connect: false,
      native_authorization_send_request: false,
      native_authorization_send_elapsed_ms: 500,
      native_authorization_origin_class: "canonical_production",
      native_app_version: null,
      native_platform: "darwin",
    };
    const cause: NativeAuthorizationCauseDiagnostic = {
      native_authorization_cause_version: 1,
      native_authorization_cause_io_kind: "connection_reset",
      native_authorization_cause_source_depth: 3,
      native_authorization_cause_source_chain_truncated: false,
    };
    telemetry.start({ connectionId: "connection", commandId: "receipt" })({
      ...result,
      terminalType: "error",
      terminalExitCode: null,
      nativeAuthorization: receipt,
      nativeAuthorizationCause: cause,
    } as never);
    const final = capture.mock.calls.at(-1)![0];
    const sent = send(final.event, final.properties!);
    expect(sent).toMatchObject({
      ...receipt,
      ...cause,
      native_app_version: "0.0.74",
      terminalType: "error",
      hackerai_frontend_build_commit: "a".repeat(40),
    });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  });

  it("keeps a response group with measured identity and no send group", () => {
    const response: NativeAuthorizationResponseDiagnostic = {
      native_authorization_response_version: 1,
      native_authorization_response_http_status: 200,
      native_authorization_response_approval: "approved_false",
      native_authorization_response_origin_class: "canonical_production",
      native_authorization_response_platform: "darwin",
      native_authorization_response_request_id_shape: "valid",
      native_authorization_response_request_id:
        "iad1::abcde-1700000000000-0123456789ab",
    };
    telemetry.start({ connectionId: "connection", commandId: "response" })({
      ...result,
      terminalType: "error",
      terminalExitCode: null,
      nativeAuthorizationResponse: response,
    } as never);
    const final = capture.mock.calls.at(-1)![0];
    const sent = send(final.event, {
      ...final.properties!,
      // A stale shared identity cannot ride on the response group.
      native_app_version: "PRIVATE",
    });
    // The receipt's own platform stays response-prefixed; the shared identity
    // is the measured runtime, never the response receipt's.
    expect(sent).toMatchObject({ ...response, ...measured });
    expect(
      Object.keys(sent).filter(
        (key) =>
          key.startsWith("native_authorization_") &&
          !key.startsWith("native_authorization_response_"),
      ),
    ).toEqual([]);
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
  });

  it("keeps the unknown class pair with measured identity, not a reported version", () => {
    const unknownPair: DesktopInvocationUnknownDiagnostic = {
      desktop_invocation_unknown_version: 1,
      desktop_invocation_unknown_class: "lifecycle_page_replaced",
    };
    const coarse: DesktopInvocationRejectionDiagnostic = {
      desktop_invocation_rejection_version: 1,
      desktop_invocation_rejection_reason: "unknown",
      desktop_invocation_rejection_adapter: "authorized_native",
    };
    telemetry.start({ connectionId: "connection", commandId: "unknown" })({
      ...result,
      terminalType: "error",
      terminalExitCode: null,
      terminalError: {
        desktop_terminal_error_diagnostic_version: 1,
        desktop_terminal_error_kind: "invocation_rejected",
      },
      invocationRejection: coarse,
      invocationUnknown: unknownPair,
    } as never);
    const final = capture.mock.calls.at(-1)![0];
    const sent = send(final.event, {
      ...final.properties!,
      // A caller-reported version neither replaces the measured identity nor
      // affects the class.
      native_app_version: "0.0.82",
      message: "Desktop page was replaced before this command started",
    });
    expect(sent).toMatchObject({ ...coarse, ...unknownPair, ...measured });
    expect(JSON.stringify(sent)).not.toContain("PRIVATE");
    expect(JSON.stringify(sent)).not.toContain("page was replaced");
  });

  it("attributes unreceipted nonzero finals and unsampled summaries", () => {
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
    telemetry.start({ connectionId: "connection", commandId: "nonzero" })({
      ...result,
      terminalExitCode: 2,
    });
    telemetry.flush();
    const [final, summary] = capture.mock.calls.map(([event]) => event);
    expect(final.event).toBe("desktop_ack_command_settled");
    expect(send(final.event, final.properties!)).toMatchObject({
      terminalExitCode: 2,
      ...measured,
    });
    expect(summary.event).toBe("desktop_ack_delivery_summary");
    expect(send(summary.event, summary.properties!)).toMatchObject({
      nonzeroExitCount: 1,
      ...measured,
    });
  });
});
