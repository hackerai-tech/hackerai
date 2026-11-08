jest.mock("next/server", () => {
  class MockNextResponse {
    public status: number;
    private body: unknown;

    constructor(body?: unknown, init?: ResponseInit) {
      this.body = body ?? "";
      this.status = init?.status ?? 200;
    }

    static json(body: unknown, init?: ResponseInit) {
      return new MockNextResponse(JSON.stringify(body), init);
    }

    async json() {
      return JSON.parse(String(this.body));
    }

    async text() {
      return String(this.body);
    }
  }

  Object.defineProperty(globalThis, "Response", {
    value: MockNextResponse,
    configurable: true,
  });

  return {
    NextResponse: MockNextResponse,
  };
});

import { handleAgentRouteError } from "@/lib/api/agent-route-errors";
import { ChatSDKError } from "@/lib/errors";

describe("handleAgentRouteError", () => {
  const originalConsoleError = console.error;
  const originalConsoleWarn = console.warn;

  beforeEach(() => {
    console.error = jest.fn();
    console.warn = jest.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  });

  test("returns ChatSDKError responses without extra logging", async () => {
    const response = handleAgentRouteError({
      error: new ChatSDKError("bad_request:api", "Missing chatId"),
      endpoint: "agent",
      action: "start",
      fallbackMessage: "Failed to start agent",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "bad_request:api",
      cause: "Missing chatId",
    });
    expect(console.error).not.toHaveBeenCalled();
  });

  test("returns a generic 500 response and logs start failures with trigger label", async () => {
    const error = new Error("queue unavailable");
    const response = handleAgentRouteError({
      error,
      endpoint: "agent",
      action: "start",
      fallbackMessage: "Failed to start agent",
      context: {
        requestId: "iad1::abc",
        userId: "user_123",
        chatId: "chat_123",
        runId: "run_123",
        stage: "trigger_task",
      },
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "bad_request:api",
      cause: "Failed to start agent",
    });
    const payload = JSON.parse(
      String((console.error as jest.Mock).mock.calls[0][0]),
    );
    expect(payload).toMatchObject({
      level: "error",
      event: "agent_route_failed",
      service: "hackerai-web",
      endpoint: "agent",
      action: "start",
      log_message: "[agent] failed to trigger task",
      request_id: "iad1::abc",
      user_id: "user_123",
      chat_id: "chat_123",
      trigger_run_id: "run_123",
      stage: "trigger_task",
      error_name: "Error",
      error_message: "queue unavailable",
    });
    expect(payload.timestamp).toEqual(expect.any(String));
  });

  test("logs non-start actions with the action-specific label", async () => {
    const error = new Error("cancel failed");
    const response = handleAgentRouteError({
      error,
      endpoint: "agent-long",
      action: "cancel",
      fallbackMessage: "Failed to cancel agent task",
    });

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      code: "bad_request:api",
      cause: "Failed to cancel agent task",
    });
    const payload = JSON.parse(
      String((console.error as jest.Mock).mock.calls[0][0]),
    );
    expect(payload).toMatchObject({
      level: "error",
      event: "agent_route_failed",
      endpoint: "agent-long",
      action: "cancel",
      log_message: "[agent-long] cancel failed",
      error_name: "Error",
      error_message: "cancel failed",
    });
  });

  test("preserves plain object error details in structured logs", async () => {
    const error = { code: "trigger_unavailable", detail: "API outage" };
    const response = handleAgentRouteError({
      error,
      endpoint: "agent",
      action: "resume",
      fallbackMessage: "Failed to resume run",
    });

    expect(response.status).toBe(500);
    const payload = JSON.parse(
      String((console.error as jest.Mock).mock.calls[0][0]),
    );
    expect(payload).toMatchObject({
      event: "agent_route_failed",
      error_name: "object",
      error_message: JSON.stringify(error),
      error_code: "trigger_unavailable",
    });
  });
});

describe("typed Agent service-unavailable receipts", () => {
  let warn: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  test.each([
    ["/api/agent", "start", "tasks.trigger"],
    ["/api/agent-long", "start", "sessions.start"],
    ["/api/agent", "status", "get_chat"],
    ["/api/agent-long", "status", "retrieve_trigger_run"],
  ] as const)(
    "records the typed503 boundary for %s %s without replacing its response",
    async (endpoint, action, stage) => {
      const error = new ChatSDKError("offline:sandbox", "PRIVATE_CAUSE", {
        value: "PRIVATE_METADATA",
      });
      const original = error.toResponse();
      const toResponse = jest
        .spyOn(error, "toResponse")
        .mockReturnValue(original);
      const response = handleAgentRouteError({
        error,
        endpoint,
        action,
        fallbackMessage: "PRIVATE_FALLBACK",
        context: {
          requestId: "sin1::abcde-1794139010452-8943ba28f213",
          stage,
          userId: "PRIVATE_USER",
          chatId: "PRIVATE_CHAT",
          runId: "PRIVATE_RUN",
          approvalSessionId: "PRIVATE_APPROVAL",
        },
      });
      expect(response).toBe(original);
      expect(toResponse).toHaveBeenCalledTimes(1);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        code: "offline:sandbox",
        cause: "PRIVATE_CAUSE",
        metadata: { value: "PRIVATE_METADATA" },
      });
      expect(warn).toHaveBeenCalledTimes(1);
      const fields = JSON.parse(warn.mock.calls[0][0]);
      expect(fields).toMatchObject({
        event: "agent_route_service_unavailable",
        agent_route_error_diagnostic_version: 1,
        http_status: 503,
        endpoint,
        action,
        stage,
        error_code: "offline:sandbox",
        request_id_kind: "vercel",
        request_id: "sin1::abcde-1794139010452-8943ba28f213",
      });
      expect(Object.keys(fields).sort()).toEqual(
        [
          "timestamp",
          "level",
          "event",
          "service",
          "agent_route_error_diagnostic_version",
          "http_status",
          "endpoint",
          "action",
          "stage",
          "error_code",
          "request_id_kind",
          "request_id",
        ].sort(),
      );
      expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    },
  );

  test("omits private or accessor metadata instead of coercing it", () => {
    const error = new ChatSDKError("offline:sandbox", "PRIVATE_CAUSE");
    const getter = jest.fn(() => "PRIVATE_ACCESSOR");
    const stringify = jest.fn(() => "PRIVATE_COERCION");
    const context = { stage: { toString: stringify } };
    Object.defineProperty(context, "requestId", { get: getter });
    handleAgentRouteError({
      error,
      endpoint: "/api/agent",
      action: "start",
      fallbackMessage: "PRIVATE",
      context: context as any,
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = JSON.parse(warn.mock.calls[0][0]);
    expect(fields).toMatchObject({
      stage: "unknown",
      request_id_kind: "unavailable",
    });
    expect(fields).not.toHaveProperty("request_id");
    expect(getter).not.toHaveBeenCalled();
    expect(stringify).not.toHaveBeenCalled();
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  });

  test("does not let an unavailable diagnostic sink alter the typed response", () => {
    const error = new ChatSDKError("offline:sandbox", "original response");
    const original = error.toResponse();
    jest.spyOn(error, "toResponse").mockReturnValue(original);
    warn.mockImplementation(() => {
      throw new Error("sink unavailable");
    });
    expect(
      handleAgentRouteError({
        error,
        endpoint: "/api/agent",
        action: "status",
        fallbackMessage: "fallback",
      }),
    ).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["8d31cf94-03cf-4c8e-a5bb-a7f5da637285", "uuid"],
    ["https://PRIVATE_TARGET/path", "unavailable"],
    ["PRIVATE".repeat(1000), "unavailable"],
    [undefined, "unavailable"],
  ])("keeps request correlation opaque for %s", (requestId, kind) => {
    handleAgentRouteError({
      error: new ChatSDKError("offline:sandbox"),
      endpoint: "/api/agent",
      action: "status",
      fallbackMessage: "fallback",
      context: { requestId, stage: "authenticate" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const fields = JSON.parse(warn.mock.calls[0][0]);
    expect(fields.request_id_kind).toBe(kind);
    if (kind === "uuid") expect(fields.request_id).toBe(requestId);
    else expect(fields).not.toHaveProperty("request_id");
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  });

  test("does not log arbitrary typed-error properties or invoke accessors", () => {
    const error = new ChatSDKError("offline:sandbox", "PRIVATE");
    const original = error.toResponse();
    jest.spyOn(error, "toResponse").mockReturnValue(original);
    const getter = jest.fn(() => "PRIVATE_SURFACE");
    Object.defineProperty(error, "surface", { get: getter });
    Object.defineProperty(error, "type", { value: "PRIVATE_TYPE" });
    expect(
      handleAgentRouteError({
        error,
        endpoint: "/api/agent",
        action: "start",
        fallbackMessage: "PRIVATE",
      }),
    ).toBe(original);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warn.mock.calls[0][0]).error_code).toBe("unrecognized");
    expect(getter).not.toHaveBeenCalled();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
  });

  test("uses the actual returned status instead of assuming every offline error is503", () => {
    const error = new ChatSDKError("offline:sandbox");
    error.statusCode = 500;
    const response = handleAgentRouteError({
      error,
      endpoint: "/api/agent",
      action: "start",
      fallbackMessage: "fallback",
    });
    expect(response.status).toBe(500);
    expect(warn).not.toHaveBeenCalled();
  });

  test.each(["resume", "cancel", "approve", "reply"] as const)(
    "keeps %s outside the measured entrypoints",
    (action) => {
      const error = new ChatSDKError("offline:sandbox");
      expect(
        handleAgentRouteError({
          error,
          endpoint: "/api/agent",
          action,
          fallbackMessage: "fallback",
        }).status,
      ).toBe(503);
      expect(warn).not.toHaveBeenCalled();
    },
  );

  test.each([
    "bad_request",
    "unauthorized",
    "forbidden",
    "not_found",
    "rate_limit",
  ] as const)("does not add a service-unavailable receipt for %s", (type) => {
    const error = new ChatSDKError(`${type}:api`);
    const original = error.toResponse();
    jest.spyOn(error, "toResponse").mockReturnValue(original);
    expect(
      handleAgentRouteError({
        error,
        endpoint: "/api/agent",
        action: "start",
        fallbackMessage: "fallback",
      }),
    ).toBe(original);
    expect(warn).not.toHaveBeenCalled();
  });
});
