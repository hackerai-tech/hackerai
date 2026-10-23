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
