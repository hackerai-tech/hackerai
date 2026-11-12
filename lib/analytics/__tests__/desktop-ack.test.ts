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
  NATIVE_AUTHORIZATION_DIAGNOSTIC_PROPERTIES,
  type NativeAuthorizationDiagnostic,
} from "../native-authorization-diagnostics";

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
    telemetry.start({ connectionId: "connection", commandId: "receipt" })({
      ...result,
      terminalType: "error",
      terminalExitCode: null,
      nativeAuthorization: receipt,
    } as never);
    const final = capture.mock.calls.at(-1)![0];
    const sent = send(final.event, final.properties!);
    expect(sent).toMatchObject({
      ...receipt,
      native_app_version: "0.0.74",
      terminalType: "error",
      hackerai_frontend_build_commit: "a".repeat(40),
    });
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
