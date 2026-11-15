import {
  projectCancellationResponseReceipt,
  recordCancellationResponse,
} from "@/lib/agent-cancellation-response";
import {
  prepareAgentCancellationTelemetry,
  type AgentCancellationAction,
} from "../agent-cancellation";
import { sanitizeAgentCancellationEvent } from "../agent-cancellation-privacy";
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

// What PostHog's before_send sees: SDK-enriched private context, then the
// same privacy filter app/providers.tsx applies before delivery.
function deliver({
  event,
  properties,
}: {
  event: string;
  properties?: Record<string, unknown>;
}) {
  return sanitizeAgentCancellationEvent({
    event,
    properties: {
      ...properties,
      token: "phc_test",
      distinct_id: "original-user",
      $lib: "web",
      $current_url: "https://hackerai.co/c/CANARY?prompt=CANARY",
      $raw_user_agent: "CANARY",
      prompt: "CANARY",
      cancellation_response_url: "https://CANARY.example/api/agent/cancel",
    },
    $set: { email: "CANARY@example.com" },
    $set_once: { $initial_referrer: "CANARY" },
  });
}
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
  expect(end.dedupeKey).toBe(start.dedupeKey);
  const delivered = deliver(end);
  expect(delivered).toEqual({
    event: "agent_run_cancellation_settled",
    properties: {
      ...deliver(start).properties,
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
  expect(JSON.stringify(delivered)).not.toContain("CANARY");
});
const REQUEST_ID = "iad1::iad1::abcd1-1763049600000-0123456789abcdef";
const RECEIPT = {
  cancellation_response_diagnostic_version: 1,
  cancellation_response_http_status: 403,
  cancellation_response_type: "basic",
  cancellation_response_redirected: "false",
  cancellation_response_url_origin: "hackerai_production",
  cancellation_response_endpoint: "agent_cancel",
  cancellation_response_platform_request_id_state: "valid",
  cancellation_response_platform_request_id: REQUEST_ID,
};
const SETTLED_ERROR = {
  schemaVersion: 1,
  cancellationId: "cancellation",
  chatId: "chat",
  triggerRunId: "run",
  action: "stop",
  reason: "stop",
  outcome: "error",
  durationMs: 5,
};
const OMIT = Symbol("omit");
function settledWith(overrides: Record<string, unknown>) {
  const properties: Record<string, unknown> = {
    ...SETTLED_ERROR,
    ...RECEIPT,
  };
  for (const [key, value] of Object.entries(overrides)) {
    const name = key in SETTLED_ERROR ? key : `cancellation_response_${key}`;
    if (value === OMIT) delete properties[name];
    else properties[name] = value;
  }
  return properties;
}
function receiptKeys(properties: Record<string, unknown> | undefined) {
  return Object.keys(properties ?? {}).filter((key) =>
    key.startsWith("cancellation_response_"),
  );
}
it.each<[string, Record<string, unknown>]>([
  ["all fields", {}],
  ["no status", { http_status: OMIT }],
  ["opaque status 0", { http_status: 0 }],
  [
    "absent request ID",
    { platform_request_id_state: "absent", platform_request_id: OMIT },
  ],
])("delivers a valid settled error receipt with %s", (_, overrides) => {
  const properties = settledWith(overrides);
  const delivered = deliver({
    event: "agent_run_cancellation_settled",
    properties,
  });
  expect(delivered.properties).toEqual({
    ...properties,
    token: "phc_test",
    distinct_id: "original-user",
    $lib: "web",
  });
  expect(delivered).not.toHaveProperty("$set");
  expect(delivered).not.toHaveProperty("$set_once");
});
it.each<[string, string, Record<string, unknown>]>([
  ["requested event", "agent_run_cancellation_requested", { outcome: OMIT }],
  [
    "accepted outcome",
    "agent_run_cancellation_settled",
    { outcome: "accepted" },
  ],
  ["stale outcome", "agent_run_cancellation_settled", { outcome: "stale_run" }],
  [
    "no version",
    "agent_run_cancellation_settled",
    { diagnostic_version: OMIT },
  ],
  ["version 2", "agent_run_cancellation_settled", { diagnostic_version: 2 }],
  [
    "string version",
    "agent_run_cancellation_settled",
    { diagnostic_version: "1" },
  ],
  ["unknown type", "agent_run_cancellation_settled", { type: "CANARY" }],
  ["boolean redirect", "agent_run_cancellation_settled", { redirected: false }],
  [
    "raw origin",
    "agent_run_cancellation_settled",
    { url_origin: "https://CANARY.example" },
  ],
  ["missing endpoint", "agent_run_cancellation_settled", { endpoint: OMIT }],
  [
    "raw endpoint",
    "agent_run_cancellation_settled",
    { endpoint: "/api/CANARY" },
  ],
  [
    "missing ID state",
    "agent_run_cancellation_settled",
    { platform_request_id_state: OMIT },
  ],
  ["status 700", "agent_run_cancellation_settled", { http_status: 700 }],
  ["string status", "agent_run_cancellation_settled", { http_status: "403" }],
  [
    "fractional status",
    "agent_run_cancellation_settled",
    { http_status: 403.5 },
  ],
  [
    "undefined status",
    "agent_run_cancellation_settled",
    { http_status: undefined },
  ],
  [
    "oversized ID",
    "agent_run_cancellation_settled",
    { platform_request_id: `${REQUEST_ID}${"a".repeat(128)}` },
  ],
  [
    "newline ID",
    "agent_run_cancellation_settled",
    { platform_request_id: `${REQUEST_ID}\nCANARY` },
  ],
  [
    "trailing newline ID",
    "agent_run_cancellation_settled",
    { platform_request_id: `${REQUEST_ID}\n` },
  ],
  [
    "separator ID",
    "agent_run_cancellation_settled",
    { platform_request_id: `${REQUEST_ID} ` },
  ],
  [
    "valid state without ID",
    "agent_run_cancellation_settled",
    { platform_request_id: OMIT },
  ],
  [
    "ID with invalid state",
    "agent_run_cancellation_settled",
    { platform_request_id_state: "invalid" },
  ],
])("drops every receipt field for %s", (_, event, overrides) => {
  const delivered = deliver({ event, properties: settledWith(overrides) });
  expect(receiptKeys(delivered.properties)).toEqual([]);
  expect(delivered.properties).toMatchObject({
    chatId: "chat",
    triggerRunId: "run",
    token: "phc_test",
  });
  expect(JSON.stringify(delivered)).not.toContain("CANARY");
});
it("projects only own data receipt fields without invoking accessors", () => {
  const read = jest.fn(() => "basic");
  const accessor = settledWith({});
  Object.defineProperty(accessor, "cancellation_response_type", {
    get: read,
    enumerable: false,
  });
  expect(projectCancellationResponseReceipt(accessor)).toBeUndefined();
  expect(read).not.toHaveBeenCalled();
  const delivered = sanitizeAgentCancellationEvent({
    event: "agent_run_cancellation_settled",
    properties: accessor,
  });
  expect(read).not.toHaveBeenCalled();
  expect(receiptKeys(delivered.properties)).toEqual([]);
  expect(
    projectCancellationResponseReceipt(Object.create(settledWith({}))),
  ).toBeUndefined();
  expect(
    projectCancellationResponseReceipt({
      ...RECEIPT,
      cancellation_response_url: "https://CANARY.example",
      cancellation_response_body: "CANARY",
    }),
  ).toEqual(RECEIPT);
});
it("keeps the existing cancellation and Stop snapshot allowlists", () => {
  const requested = deliver({
    event: "agent_run_cancellation_requested",
    properties: {
      ...SETTLED_ERROR,
      hackerai_frontend_build_commit: "a".repeat(40),
    },
  });
  expect(requested).toEqual({
    event: "agent_run_cancellation_requested",
    properties: {
      ...SETTLED_ERROR,
      hackerai_frontend_build_commit: "a".repeat(40),
      token: "phc_test",
      distinct_id: "original-user",
      $lib: "web",
    },
  });
  const snapshot = deliver({
    event: "chat_stop_snapshot_save_outcome",
    properties: {
      diagnostic_version: 1,
      save_outcome: "saved",
      ...RECEIPT,
      outcome: "error",
    },
  });
  expect(snapshot.properties).toEqual({
    diagnostic_version: 1,
    save_outcome: "saved",
    token: "phc_test",
    distinct_id: "original-user",
    $lib: "web",
  });
  const unrelated = {
    event: "other_event",
    properties: { ...RECEIPT },
    $set: {},
  };
  expect(sanitizeAgentCancellationEvent(unrelated)).toBe(unrelated);
  expect(unrelated).toEqual({
    event: "other_event",
    properties: RECEIPT,
    $set: {},
  });
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
