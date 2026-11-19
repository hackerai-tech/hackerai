import type { NextRequest } from "next/server";
import { ConvexError } from "convex/values";
import { ChatSDKError } from "@/lib/errors";
import { phLogger } from "@/lib/posthog/server";
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { warn: jest.fn() },
}));
jest.mock("next/server", () => ({}));
jest.mock("convex/browser", () =>
  jest.requireActual(
    "../../../../node_modules/convex/dist/cjs/browser/index.js",
  ),
);
class MockResponse {
  readonly status: number;
  constructor(
    private body: unknown,
    init?: { status?: number },
  ) {
    this.status = init?.status ?? 200;
  }
  static json(body: unknown, init?: { status?: number }) {
    return new MockResponse(body, init);
  }
  async json() {
    return this.body;
  }
}
Object.defineProperty(globalThis, "Response", {
  configurable: true,
  value: MockResponse,
});
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: jest.fn(async () => ({
    userId: "owner",
    subscription: "pro",
  })),
}));
jest.mock("@/lib/goals/server", () => ({
  goalServiceKey: () => "synthetic",
  reconcileGoal: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({ mutation: mockMutation })),
}));
jest.mock("@/lib/db/actions", () => ({
  getChatById: (...args: unknown[]) => mockChat(...args),
}));
jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: (...args: unknown[]) => mockCancel(...args),
  closeAgentApprovalSession: jest.fn(),
}));
jest.mock("@/lib/goals/analytics", () => ({
  captureGoalLifecycle: jest.fn(async () => undefined),
}));
import { GET, POST } from "../route";
const mockMutation = jest.fn(),
  mockChat = jest.fn(),
  mockCancel = jest.fn();
const request = (body: unknown) => ({ json: async () => body }) as NextRequest;
describe("goal control admission", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockChat.mockResolvedValue({ user_id: "owner" });
    mockMutation.mockResolvedValue({
      state: "paused",
      generation: 5,
      activeRunId: "claimed-run",
    });
  });
  it.each([
    null,
    [],
    {},
    { chatId: "chat", action: "resume" },
    { chatId: "", action: "pause" },
  ])("rejects invalid bodies with 400: %p", async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("rejects malformed JSON with 400", async () => {
    const req = {
      json: async () => {
        throw new SyntaxError("Invalid JSON");
      },
    } as unknown as NextRequest;
    expect((await POST(req)).status).toBe(400);
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("checks ownership before changing or canceling a run", async () => {
    mockChat.mockResolvedValue({ user_id: "other" });
    expect(
      (await POST(request({ chatId: "chat", action: "pause" }))).status,
    ).toBe(403);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
  it("forwards the selected goal generation before canceling", async () => {
    expect(
      (await POST(request({ chatId: "chat", action: "clear", generation: 4 })))
        .status,
    ).toBe(200);
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 4, action: "clear" }),
    );
  });
  it("cancels the authoritative run returned by the control mutation", async () => {
    expect(
      (await POST(request({ chatId: "chat", action: "pause" }))).status,
    ).toBe(200);
    expect(mockCancel).toHaveBeenCalledWith("claimed-run");
    expect(mockMutation.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancel.mock.invocationCallOrder[0],
    );
  });
  it("returns the saved generation for a fenced continuation", async () => {
    const response = await POST(
      request({
        chatId: "chat",
        action: "update",
        generation: 4,
        objective: "Revised request",
        criteria: ["Revised request"],
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ state: "paused", generation: 5 });
  });
});

describe("goal status transport recovery", () => {
  it.each([false, true])(
    "%s: recovers one reset or fails closed on exhaustion",
    async (exhausted) => {
      const { createServiceConvexClient } =
        require("@/lib/db/service-client") as typeof import("@/lib/db/service-client");
      const { Response: FetchResponse } = jest.requireActual(
        "next/dist/compiled/@edge-runtime/primitives/fetch",
      );
      const nativeAbort = require("node:util").transferableAbortController();
      const originals = Object.fromEntries(
        ["Response", "AbortController", "AbortSignal", "crypto", "fetch"].map(
          (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)!],
        ),
      );
      for (const [name, value] of Object.entries({
        Response: FetchResponse,
        AbortController: nativeAbort.constructor,
        AbortSignal: nativeAbort.signal.constructor,
        crypto: require("node:crypto").webcrypto,
      }))
        Object.defineProperty(globalThis, name, {
          value,
          configurable: true,
          writable: true,
        });
      let attempts = 0;
      const bodies: Array<{
        path: string;
        args: Array<Record<string, unknown>>;
      }> = [];
      const transport = jest.fn(async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        if (++attempts === 1 || exhausted)
          throw new TypeError("fetch failed", {
            cause: Object.assign(new Error("read reset"), {
              code: "ECONNRESET",
            }),
          });
        return new FetchResponse(
          '{"status":"success","value":{"state":"paused","generation":5},"logLines":[]}',
        );
      });
      const originalServiceKey = process.env.CONVEX_SERVICE_ROLE_KEY;
      process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-goal-recovery-key";
      Object.defineProperty(globalThis, "fetch", {
        value: transport,
        writable: true,
        configurable: true,
      });
      const client = createServiceConvexClient("https://fixture.convex.cloud");
      const { getConvexClient } = require("@/lib/db/convex-client");
      getConvexClient.mockReturnValue(client);
      const goals = require("@/lib/goals/server");
      const productionGoals = jest.requireActual("@/lib/goals/server");
      goals.reconcileGoal.mockImplementationOnce(productionGoals.reconcileGoal);
      mockMutation.mockClear();
      mockCancel.mockClear();
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const info = jest.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await GET({
          nextUrl: new URL("https://fixture.test/api/agent-goal?chatId=chat"),
          signal: nativeAbort.signal,
        } as unknown as NextRequest);
        expect(response.status).toBe(exhausted ? 503 : 200);
        if (!exhausted)
          expect(await response.json()).toEqual({
            enabled: true,
            goal: { state: "paused", generation: 5 },
          });
        expect(transport).toHaveBeenCalledTimes(2);
        expect(getConvexClient).toHaveBeenCalled();
        for (const body of bodies) {
          expect(body.path).toBe("agentGoals:getForBackend");
          expect(body.args[0]).toMatchObject({
            userId: "owner",
            chatId: "chat",
          });
        }
        expect(mockMutation).not.toHaveBeenCalled();
        expect(mockCancel).not.toHaveBeenCalled();
      } finally {
        for (const [name, descriptor] of Object.entries(originals)) {
          if (descriptor) Object.defineProperty(globalThis, name, descriptor);
          else Reflect.deleteProperty(globalThis, name);
        }
        if (originalServiceKey === undefined)
          delete process.env.CONVEX_SERVICE_ROLE_KEY;
        else process.env.CONVEX_SERVICE_ROLE_KEY = originalServiceKey;
        getConvexClient.mockImplementation(() => ({ mutation: mockMutation }));
        warn.mockRestore();
        info.mockRestore();
      }
    },
  );
});

describe("goal status failure diagnostics", () => {
  const warn = jest.mocked(phLogger.warn);
  const auth = jest.mocked(require("@/lib/auth/get-user-id").getUserIDAndPro);
  const reconcile = jest.mocked(require("@/lib/goals/server").reconcileGoal);
  const statusRequest = () =>
    ({
      nextUrl: new URL(
        "https://fixture.test/api/agent-goal?chatId=PRIVATE_CHAT",
      ),
    }) as unknown as NextRequest;

  beforeEach(() => {
    jest.clearAllMocks();
    warn.mockReset();
    reconcile.mockReset();
  });

  it.each([
    [
      Object.assign(new ConvexError("Goal chat unavailable"), {
        message: "[Request ID: abcdef0123456789] PRIVATE_DETAIL",
      }),
      "goal_chat_unavailable",
      "abcdef0123456789",
      "get_goal",
    ],
    [
      new TypeError("PRIVATE_URL", { cause: new Error("PRIVATE_CAUSE") }),
      "type_error",
      "none",
      "retrieve_run",
    ],
    [
      Object.assign(new ConvexError("[Request ID: 0123456789abcdef] x"), {
        data: {
          code: "CHAT_ACCESS_SUSPENDED",
          message: "PRIVATE_SUSPENSION",
        },
      }),
      "chat_access_suspended",
      "0123456789abcdef",
      "clear_active_run",
    ],
  ])(
    "records one finite cause and safe request join without changing the unavailable response",
    async (error, kind, requestId, step) => {
      reconcile.mockImplementationOnce(async (_chat, _user, onStep) => {
        onStep("get_goal");
        if (step !== "get_goal") onStep(step);
        throw error;
      });
      const response = await GET(statusRequest());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        message: "Goal access unavailable",
      });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("agent_goal_status_unavailable", {
        diagnostic_version: 1,
        failure_stage: "goal_reconciliation",
        reconciliation_step: step,
        failure_kind: kind,
        convex_request_id: requestId,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_");
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(mockMutation).not.toHaveBeenCalled();
      expect(mockCancel).not.toHaveBeenCalled();
    },
  );

  it("does not attribute a failure after successful reconciliation to its last step", async () => {
    reconcile.mockImplementationOnce(async (_chat, _user, onStep) => {
      onStep("get_goal");
      onStep("capture_lifecycle");
      return { state: "paused" };
    });
    const json = jest.spyOn(MockResponse, "json").mockImplementationOnce(() => {
      throw new Error("PRIVATE_SERIALIZATION");
    });
    try {
      const response = await GET(statusRequest());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        message: "Goal access unavailable",
      });
    } finally {
      json.mockRestore();
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent_goal_status_unavailable", {
      diagnostic_version: 1,
      failure_stage: "goal_reconciliation",
      reconciliation_step: "unknown",
      failure_kind: "other_error",
      convex_request_id: "none",
    });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it("keeps logging best effort and attributes nonstandard auth lookup failures", async () => {
    auth.mockRejectedValueOnce(new Error("PRIVATE_AUTH_ERROR"));
    warn.mockImplementationOnce(() => {
      throw new Error("PRIVATE_LOGGER_ERROR");
    });
    const response = await GET(statusRequest());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      message: "Goal access unavailable",
    });
    expect(warn).toHaveBeenCalledWith(
      "agent_goal_status_unavailable",
      expect.objectContaining({
        failure_stage: "auth_lookup",
        failure_kind: "other_error",
        convex_request_id: "none",
      }),
    );
    expect(warn.mock.calls[0][1]).not.toHaveProperty("reconciliation_step");
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("preserves typed auth responses without treating them as new unavailable failures", async () => {
    const error = new ChatSDKError("unauthorized:chat");
    auth.mockRejectedValueOnce(error);
    const expected = error.toResponse();
    const response = await GET(statusRequest());
    expect(response.status).toBe(expected.status);
    expect(await response.json()).toEqual(await expected.json());
    expect(warn).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("does not evaluate error accessors or retain malformed private request identifiers", async () => {
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    const error = new Error("PRIVATE_MESSAGE");
    for (const key of ["message", "data", "cause"])
      Object.defineProperty(error, key, { get: getter });
    for (const failure of [
      error,
      new Error("[Request ID: PRIVATE_REQUEST_ID] PRIVATE_MESSAGE"),
    ]) {
      reconcile.mockRejectedValueOnce(failure);
      expect((await GET(statusRequest())).status).toBe(503);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(2);
    for (const [, fields] of warn.mock.calls)
      expect(fields).toEqual({
        diagnostic_version: 1,
        failure_stage: "goal_reconciliation",
        reconciliation_step: "unknown",
        failure_kind: "other_error",
        convex_request_id: "none",
      });
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE_");
  });

  it("attributes the actual reconciliation read without a retry or control write", async () => {
    const { getConvexClient } = require("@/lib/db/convex-client");
    const query = jest.fn(async () => {
      throw Object.assign(
        new ConvexError("[Request ID: ABCDEF0123456789] Server Error"),
        { data: "Goal chat unavailable" },
      );
    });
    getConvexClient.mockReturnValue({ query, mutation: mockMutation });
    reconcile.mockImplementationOnce(
      jest.requireActual("@/lib/goals/server").reconcileGoal,
    );
    const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;
    process.env.CONVEX_SERVICE_ROLE_KEY = "synthetic-goal-status-key";
    try {
      const response = await GET(statusRequest());
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({
        message: "Goal access unavailable",
      });
    } finally {
      if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
      else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
      getConvexClient.mockImplementation(() => ({ mutation: mockMutation }));
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("agent_goal_status_unavailable", {
      diagnostic_version: 1,
      failure_stage: "goal_reconciliation",
      reconciliation_step: "get_goal",
      failure_kind: "goal_chat_unavailable",
      convex_request_id: "abcdef0123456789",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

describe("goal control failure diagnostics", () => {
  const warn = jest.mocked(phLogger.warn);
  const auth = jest.mocked(require("@/lib/auth/get-user-id").getUserIDAndPro);
  const close = jest.mocked(
    require("@/lib/api/agent-approval-session").closeAgentApprovalSession,
  );
  const capture = jest.mocked(
    require("@/lib/goals/analytics").captureGoalLifecycle,
  );
  const unavailable = {
    message: "Goal control could not finish. Reload to check saved state.",
  };
  const pause = { chatId: "chat", action: "pause" };
  const update = {
    chatId: "chat",
    action: "update",
    generation: 4,
    objective: "Revised request",
    criteria: ["Revised request"],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    warn.mockReset();
    mockChat.mockResolvedValue({
      user_id: "owner",
      active_agent_approval_session_id: "approval",
    });
    mockMutation.mockResolvedValue({
      state: "paused",
      generation: 5,
      activeRunId: "claimed-run",
    });
  });

  it.each([
    {
      stage: "auth_lookup",
      inject: () => auth.mockRejectedValueOnce(new Error("PRIVATE_AUTH")),
      kind: "other_error",
      calls: [0, 0, 0, 0],
    },
    {
      stage: "parse_request",
      // A synchronous body-reader failure escapes the existing 400 fallback.
      request: {
        json: () => {
          throw new Error("PRIVATE_BODY");
        },
      },
      kind: "other_error",
      calls: [0, 0, 0, 0],
    },
    {
      stage: "get_chat",
      inject: () =>
        mockChat.mockRejectedValueOnce(
          new ConvexError("[Request ID: 0123456789abcdef] PRIVATE_CHAT"),
        ),
      kind: "convex_error",
      requestId: "0123456789abcdef",
      calls: [0, 0, 0, 0],
    },
    {
      stage: "update_goal",
      body: update,
      inject: () =>
        mockMutation.mockRejectedValueOnce(new TypeError("PRIVATE_FETCH")),
      kind: "type_error",
      calls: [1, 0, 0, 0],
    },
    {
      stage: "control_goal",
      inject: () =>
        mockMutation.mockRejectedValueOnce(
          Object.assign(new ConvexError("Goal chat unavailable"), {
            message: "[Request ID: ABCDEF0123456789] PRIVATE_GOAL",
          }),
        ),
      kind: "goal_chat_unavailable",
      requestId: "abcdef0123456789",
      calls: [1, 0, 0, 0],
    },
    {
      stage: "close_approval_session",
      inject: () => close.mockRejectedValueOnce(new Error("PRIVATE_CLOSE")),
      kind: "other_error",
      calls: [1, 1, 0, 0],
    },
    {
      // The control mutation already succeeded; it is not retried or replayed.
      stage: "cancel_trigger_run",
      inject: () => mockCancel.mockRejectedValueOnce("PRIVATE_THROWN"),
      kind: "thrown_value",
      calls: [1, 1, 1, 0],
    },
    {
      stage: "capture_lifecycle",
      body: update,
      inject: () => capture.mockRejectedValueOnce(new Error("PRIVATE_CAPTURE")),
      kind: "other_error",
      calls: [1, 1, 1, 1],
    },
    {
      stage: "response",
      inject: () =>
        jest.spyOn(MockResponse, "json").mockImplementationOnce(() => {
          throw new Error("PRIVATE_RESPONSE");
        }),
      kind: "other_error",
      calls: [1, 1, 1, 1],
    },
  ])(
    "attributes a generic failure to $stage without replaying earlier work",
    async ({
      stage,
      request: custom,
      body,
      inject,
      kind,
      requestId,
      calls,
    }) => {
      inject?.();
      try {
        const response = await POST(
          (custom ?? request(body ?? pause)) as unknown as NextRequest,
        );
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual(unavailable);
      } finally {
        jest.restoreAllMocks();
      }
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("agent_goal_control_unavailable", {
        diagnostic_version: 1,
        failure_stage: stage,
        failure_kind: kind,
        convex_request_id: requestId ?? "none",
      });
      // No error content or request/user/chat/run/approval identifiers.
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(
        /PRIVATE|owner|claimed-run|"chat"|"approval"|Revised/,
      );
      expect([
        mockMutation.mock.calls.length,
        close.mock.calls.length,
        mockCancel.mock.calls.length,
        capture.mock.calls.length,
      ]).toEqual(calls);
    },
  );

  it("cancels the run returned by a successful update before any later failure", async () => {
    capture.mockRejectedValueOnce(new Error("PRIVATE_CAPTURE"));
    expect((await POST(request(update))).status).toBe(503);
    expect(mockMutation).toHaveBeenCalledTimes(1);
    expect(mockMutation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ generation: 4, objective: "Revised request" }),
    );
    expect(close).toHaveBeenCalledWith("approval", "goal-user-control");
    expect(mockCancel).toHaveBeenCalledWith("claimed-run");
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(
      mockCancel.mock.invocationCallOrder[0],
    );
  });

  it.each(["auth_lookup", "cancel_trigger_run"])(
    "keeps a typed error from %s as its own response without a warning",
    async (stage) => {
      const error = new ChatSDKError("unauthorized:chat");
      if (stage === "auth_lookup") auth.mockRejectedValueOnce(error);
      else mockCancel.mockRejectedValueOnce(error);
      const expected = error.toResponse();
      const response = await POST(request(pause));
      expect(response.status).toBe(expected.status);
      expect(await response.json()).toEqual(await expected.json());
      expect(warn).not.toHaveBeenCalled();
      expect(mockMutation).toHaveBeenCalledTimes(
        stage === "auth_lookup" ? 0 : 1,
      );
    },
  );

  it("does not warn for successful, invalid or foreign-chat controls", async () => {
    expect((await POST(request(pause))).status).toBe(200);
    expect((await POST(request(update))).status).toBe(200);
    expect((await POST(request({ chatId: "chat" }))).status).toBe(400);
    mockChat.mockResolvedValueOnce({ user_id: "other" });
    expect((await POST(request(pause))).status).toBe(403);
    expect(warn).not.toHaveBeenCalled();
    expect(mockMutation).toHaveBeenCalledTimes(2);
  });

  it("keeps the unavailable response when logging or error inspection fails", async () => {
    const getter = jest.fn(() => {
      throw new Error("PRIVATE_GETTER");
    });
    const accessorError = new Error("PRIVATE_MESSAGE");
    for (const key of ["message", "data"])
      Object.defineProperty(accessorError, key, { get: getter });
    const proxyError = new Proxy(new Error("PRIVATE_PROXY"), {
      getOwnPropertyDescriptor() {
        throw new Error("PRIVATE_TRAP");
      },
    });
    mockMutation
      .mockRejectedValueOnce(accessorError)
      .mockRejectedValueOnce(proxyError)
      .mockRejectedValueOnce(new Error("[Request ID: PRIVATE_ID] x"));
    warn.mockImplementationOnce(() => {
      throw new Error("PRIVATE_LOGGER");
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const response = await POST(request(pause));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual(unavailable);
    }
    expect(getter).not.toHaveBeenCalled();
    expect(warn.mock.calls.map(([, fields]) => fields)).toEqual(
      [
        ["other_error", "none"],
        ["unreadable_error", "none"],
        ["other_error", "none"],
      ].map(([failure_kind, convex_request_id]) => ({
        diagnostic_version: 1,
        failure_stage: "control_goal",
        failure_kind,
        convex_request_id,
      })),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("PRIVATE");
    expect(mockMutation).toHaveBeenCalledTimes(3);
    expect(mockCancel).not.toHaveBeenCalled();
  });
});

// Menu eligibility is a plan decision, independent of analytics configuration.
it.each(["free", "pro", "pro-plus", "ultra", "team"])(
  "reports goal access for the authenticated %s plan",
  async (subscription) => {
    require("@/lib/auth/get-user-id").getUserIDAndPro.mockResolvedValueOnce({
      userId: "owner",
      subscription,
    });
    const response = await GET({
      nextUrl: new URL("https://fixture.test/api/agent-goal"),
    } as NextRequest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: subscription !== "free" });
  },
);
