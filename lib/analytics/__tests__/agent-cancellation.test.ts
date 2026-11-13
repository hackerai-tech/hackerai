import { recordCancellationResponse } from "@/lib/agent-cancellation-response";
import {
  prepareAgentCancellationTelemetry,
  type AgentCancellationAction,
} from "../agent-cancellation";
import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
} from "../client";
jest.mock("../client", () => ({
  captureQueuedAuthenticatedEvent: jest.fn(),
  getIdentifiedAnalyticsUserId: jest.fn(),
}));
const capture = jest.mocked(captureQueuedAuthenticatedEvent);
const identity = jest.mocked(getIdentifiedAnalyticsUserId);
beforeEach(() => {
  jest.resetAllMocks();
  identity.mockReturnValue("original-user");
});
it.each<[AgentCancellationAction, string]>([
  ["stop", "stop"],
  ["stop_and_send", "steer"],
  ["send_now", "steer"],
  ["regenerate", "replace"],
  ["retry", "replace"],
  ["edit", "replace"],
])("correlates %s with its exact run and %s reason", (action, reason) => {
  const begin = prepareAgentCancellationTelemetry("chat", action);
  const finish = begin("captured-run");
  finish("accepted");
  finish("error");
  expect(capture).toHaveBeenCalledTimes(2);
  const [start, end] = capture.mock.calls.map(([x]) => x);
  expect(start.event).toBe("agent_run_cancellation_requested");
  expect(start.properties).toMatchObject({
    triggerRunId: "captured-run",
    chatId: "chat",
    action,
    reason,
  });
  expect(end).toMatchObject({
    event: "agent_run_cancellation_settled",
    dedupeKey: start.dedupeKey,
    properties: {
      ...start.properties,
      outcome: "accepted",
      durationMs: expect.any(Number),
    },
  });
});
it.each(["before_start", "before_result"])(
  "never attributes a cancellation across login change %s",
  (phase) => {
    const begin = prepareAgentCancellationTelemetry("chat", "stop");
    if (phase === "before_start") identity.mockReturnValue("replacement-user");
    const finish = begin("run");
    identity.mockReturnValue("replacement-user");
    finish("accepted");
    expect(capture).toHaveBeenCalledTimes(phase === "before_start" ? 0 : 1);
  },
);
it("does not invent identity or include error details", () => {
  identity.mockReturnValue(null);
  prepareAgentCancellationTelemetry("chat", "stop")("run")("error");
  expect(capture).not.toHaveBeenCalled();
  identity.mockReturnValue("original-user");
  const finish = prepareAgentCancellationTelemetry("chat", "stop")("run");
  finish("error");
  expect(capture.mock.calls[1][0].properties).toMatchObject({
    outcome: "error",
  });
  expect(capture.mock.calls[1][0].properties).not.toHaveProperty("error");
});
it("settles a terminal rejection with only its recorded response receipt", () => {
  const rejection = new Error("Agent cancellation failed with status 403");
  recordCancellationResponse(rejection, {
    status: 403,
    type: "cors",
    redirected: true,
    url: "https://hackerai.co/api/agent/cancel?token=CANARY",
    headers: {
      get: (name: string) =>
        name === "x-vercel-id"
          ? "sfo1::abcd1-1763049600000-deadbeef"
          : "session=CANARY",
    },
  } as unknown as Response);
  const finish = prepareAgentCancellationTelemetry("chat", "stop")("run");
  finish("error", rejection);
  finish("error", rejection);
  expect(capture).toHaveBeenCalledTimes(2);
  const [start, end] = capture.mock.calls.map(([x]) => x);
  expect(end).toEqual({
    event: "agent_run_cancellation_settled",
    dedupeKey: start.dedupeKey,
    properties: {
      ...start.properties,
      schemaVersion: 1,
      outcome: "error",
      durationMs: expect.any(Number),
      cancellation_response_diagnostic_version: 1,
      cancellation_response_http_status: 403,
      cancellation_response_type: "cors",
      cancellation_response_redirected: "true",
      cancellation_response_url_origin: "hackerai_production",
      cancellation_response_endpoint: "agent_cancel",
      cancellation_response_platform_request_id_state: "valid",
      cancellation_response_platform_request_id:
        "sfo1::abcd1-1763049600000-deadbeef",
    },
  });
  expect(JSON.stringify(end)).not.toContain("CANARY");
});
it.each([
  ["accepted", "recorded rejection"],
  ["error", "unrelated error"],
  ["error", "hostile error"],
] as const)("adds no receipt for %s with %s", (outcome, kind) => {
  const recorded = new Error("terminal");
  recordCancellationResponse(recorded, { status: 403 } as Response);
  const error =
    kind === "recorded rejection"
      ? recorded
      : kind === "unrelated error"
        ? new Error("Agent cancellation failed with status 403")
        : new Proxy(
            {},
            {
              get: () => {
                throw new Error("error properties must not be read");
              },
              getPrototypeOf: () => {
                throw new Error("error properties must not be read");
              },
            },
          );
  prepareAgentCancellationTelemetry("chat", "stop")("run")(outcome, error);
  const { properties } = capture.mock.calls[1][0];
  expect(properties).toMatchObject({ outcome });
  expect(
    Object.keys(properties).filter((key) =>
      key.startsWith("cancellation_response_"),
    ),
  ).toEqual([]);
});
it("cannot break cancellation when analytics throws", () => {
  capture.mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(() =>
    prepareAgentCancellationTelemetry("chat", "stop")("run")("accepted"),
  ).not.toThrow();
  identity.mockImplementation(() => {
    throw new Error("unavailable");
  });
  expect(() =>
    prepareAgentCancellationTelemetry("chat", "stop")("run")("error"),
  ).not.toThrow();
});
