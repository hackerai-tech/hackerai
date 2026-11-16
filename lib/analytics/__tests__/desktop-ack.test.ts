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
  NATIVE_AUTHORIZATION_TRANSPORT_PROPERTIES,
  type NativeAuthorizationCauseDiagnostic,
  type NativeAuthorizationConnectorDiagnostic,
  type NativeAuthorizationDiagnostic,
  type NativeAuthorizationIoDiagnostic,
  type NativeAuthorizationMitigationDiagnostic,
  type NativeAuthorizationResponseDiagnostic,
  type NativeAuthorizationResponseReadDiagnostic,
  type NativeAuthorizationTransportDiagnostic,
} from "../native-authorization-diagnostics";
import {
  DESKTOP_TERMINAL_ERROR_PROPERTIES,
  type DesktopTerminalErrorDiagnostic,
} from "../desktop-terminal-error-diagnostics";

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
