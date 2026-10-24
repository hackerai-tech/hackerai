import { startDesktopAckTelemetry } from "../desktop-ack";
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "../client";
import type { AcknowledgedCommandSettlement } from "@/lib/centrifugo/acknowledged-command-output";
import { sanitizeDesktopAckEvent } from "../desktop-ack-privacy";

jest.mock("../client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
}));
const capture = jest.mocked(captureQueuedAuthenticatedEvent);
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
const result: AcknowledgedCommandSettlement = {
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
  terminalAcknowledged: true,
  durationMs: 2000,
};
const originalCommit = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
beforeEach(() => {
  jest.clearAllMocks();
  identity.mockReturnValue("original-user");
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = "a".repeat(40);
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
    dedupeKey: "connection:command",
    properties: {
      ...result,
      schemaVersion: 1,
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
