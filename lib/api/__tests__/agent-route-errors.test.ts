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
    });

    expect(response.status).toBe(500);
    expect(await response.text()).toBe("Failed to start agent");
    expect(console.error).toHaveBeenCalledWith(
      "[agent] failed to trigger task:",
      error,
    );
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
    expect(await response.text()).toBe("Failed to cancel agent task");
    expect(console.error).toHaveBeenCalledWith(
      "[agent-long] cancel failed:",
      error,
    );
  });
});
