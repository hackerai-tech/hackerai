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

  beforeEach(() => {
    console.error = jest.fn();
  });

  afterEach(() => {
    console.error = originalConsoleError;
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
