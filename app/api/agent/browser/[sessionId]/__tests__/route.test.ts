import { after, type NextRequest } from "next/server";
import { phLogger } from "@/lib/posthog/server";
import {
  BrowserPreviewUnavailable,
  getActiveBrowserSessionName,
} from "@/lib/ai/browser-handoff/server";

const mockStartRelay = jest.fn(async () => {
  if (mockFailure === "relay-start") throw new Error("Relay startup failed");
  return "https://relay.example";
});
const mockStopRelay = jest.fn(async () => {
  if (mockFailure === "relay-stop") throw new Error("Relay still draining");
});
const mockRenewRelay = jest.fn(async (..._args: unknown[]) => undefined);
const mockCapture = jest.fn(async (..._args: unknown[]) => {
  if (mockFailure === "capture" || mockFailure === "unpause")
    throw new Error(
      "PRIVATE capture failed: https://private.invalid/?token=PRIVATE_TOKEN",
    );
  return { image: "fresh" };
});
const mockResize = jest.fn(async (..._args: unknown[]) => ({
  image: "resized",
}));
const mockSendInput = jest.fn(async (..._args: unknown[]) => {
  if (mockFailure === "pointer-release")
    throw new Error("Pointer release failed");
});
const mockStreamPort = jest.fn(async (..._args: unknown[]) => 1234);
const mockRenewContext = jest.fn(
  (_error: unknown): Record<string, unknown> => ({
    relay_renew_diagnostic_version: 2,
    relay_renew_error_kind: "command_exit",
    relay_renew_command_exit_code: 42,
    relay_renew_failure_reason: "lock_busy",
  }),
);
const mockStopContext = jest.fn((_error: unknown): Record<string, unknown> => ({
  relay_stop_diagnostic_version: 1,
  relay_stop_error_kind: "command_exit",
  relay_stop_http_status: "none",
  relay_stop_command_exit_code: 1,
}));
const mockSessionId = "a".repeat(32);
let mockState = "recovery";
let mockRunActive = true;
let mockPaused = true;
let mockFailure = "capture";
const mockMutation = jest.fn(
  async (name: string, args: { paused?: boolean }) => {
    if (name === "saveExitNoteForBackend") {
      if (mockFailure === "save") throw new Error("Save failed");
      return {
        id: "saved-note",
        text: "Saved context",
        runActive: mockRunActive,
      };
    }
    if (name === "beginTakeoverForBackend") return true;
    if (name === "finishTakeoverForBackend") return mockFailure !== "claim";
    if (name === "abortTakeoverForBackend")
      mockState = args.paused ? "recovery" : "agent";
    return true;
  },
);
const mockPause = jest.fn(
  async (_sandbox: unknown, _session: unknown, paused: boolean) => {
    if (!paused && mockFailure === "unpause") throw new Error("Disconnected");
    mockPaused = paused;
  },
);
jest.mock("next/server", () => ({
  after: jest.fn(),
  NextResponse: {
    json: (body: unknown, init: { status: number }) => ({
      status: init.status,
      json: async () => body,
    }),
  },
}));
jest.mock("@/convex/_generated/api", () => ({
  api: { browserHandoffs: new Proxy({}, { get: (_target, name) => name }) },
}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: async () => {
    if (mockFailure === "auth") throw new Error("Not signed in");
    return "owner";
  },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: async () => {
      if (mockFailure === "lookup")
        throw new Error("Backend lookup unavailable");
      if (mockFailure === "missing") return null;
      return {
        sessionId: mockSessionId,
        runId: `run_${"a".repeat(26)}`,
        chatId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        directory: "/PRIVATE_BROWSER_DIRECTORY",
        grant: "PRIVATE_GRANT",
        state: mockState,
        runActive: mockRunActive,
        controlledSessionName: "default",
      };
    },
    mutation: mockMutation,
  }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), info: jest.fn(), flush: jest.fn() },
}));
jest.mock("@/lib/ai/browser-handoff/server", () => ({
  browserRelayStopFailureContext: (error: unknown) => mockStopContext(error),
  browserRelayRenewFailureContext: (error: unknown) => mockRenewContext(error),
  browserSessionReadFailureContext: () =>
    mockFailure === "read-active"
      ? {
          active_session_read_diagnostic_version: 1,
          active_session_read_error_kind: "file_not_found",
          active_session_read_http_status: 404,
        }
      : undefined,
  BrowserPreviewUnavailable: class extends Error {
    constructor(public state: string) {
      super(state);
    }
  },
  resizeBrowserViewport: (...args: unknown[]) => mockResize(...args),
  sendBrowserInput: (...args: unknown[]) => mockSendInput(...args),
  startBrowserRelay: () => mockStartRelay(),
  renewBrowserRelay: (...args: unknown[]) => mockRenewRelay(...args),
  stopBrowserRelays: () => mockStopRelay(),
  connectBrowserSandbox: async () => {
    if (mockFailure === "connect") throw new Error("PRIVATE sandbox");
    return {};
  },
  getActiveBrowserSessionName: jest.fn(async () => {
    if (mockFailure === "read-active")
      throw new BrowserPreviewUnavailable("loading");
    return mockFailure === "identity" ? "another-browser" : "default";
  }),
  setAgentBrowserPaused: (...args: Parameters<typeof mockPause>) =>
    mockPause(...args),
  captureBrowserFrame: (...args: unknown[]) => mockCapture(...args),
  getPrivateStreamPort: (...args: unknown[]) => mockStreamPort(...args),
}));

let post: typeof import("../route").POST;
let get: typeof import("../route").GET;
beforeAll(async () => {
  const original = process.env.CONVEX_SERVICE_ROLE_KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-only-service-key";
  try {
    ({ POST: post, GET: get } = await import("../route"));
  } finally {
    if (original === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = original;
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  mockState = "recovery";
  mockRunActive = true;
  mockPaused = true;
  mockFailure = "capture";
});

const jsonBody = (value: unknown) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  });

const preview = (
  fresh: boolean,
  requestId = "iad1::qa123-1794060000000-abcdef123456",
) =>
  get(
    {
      headers: new Headers({
        "x-vercel-id": requestId,
      }),
      nextUrl: new URL(
        `https://preview.example/api/agent/browser/test${fresh ? "?fresh=1" : ""}`,
      ),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

it.each([false, true])(
  "honors an authenticated fresh screenshot request (fresh: %s)",
  async (fresh) => {
    mockFailure = "";
    mockState = "human";
    const result = await preview(fresh);
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ frame: { image: "fresh" } });
    expect(mockCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "default",
      fresh,
      undefined,
      expect.any(Function),
    );
  },
);

it.each([
  ["auth", 401],
  ["identity", 409],
  ["missing", 404],
])(
  "does not capture a fresh screenshot after %s validation fails",
  async (failure, status) => {
    mockFailure = String(failure);
    mockState = "human";
    expect((await preview(true)).status).toBe(status);
    expect(mockCapture).not.toHaveBeenCalled();
    expect(phLogger.info).not.toHaveBeenCalled();
  },
);

it.each([
  ["lookup", "resolve_session", "disconnected"],
  ["connect", "connect_sandbox", "disconnected"],
  ["read-active", "read_active_session", "loading"],
  ["capture", "capture_frame", "disconnected"],
])(
  "records one bounded GET diagnostic for %s without changing the response",
  async (failure, stage, state) => {
    mockFailure = failure;
    const response = await preview(true);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state });
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_get_unavailable",
      expect.objectContaining({
        diagnostic_version: 1,
        failure_stage: stage,
        preview_state: state,
        browser_session_id: mockSessionId,
        fresh_requested: true,
        request_id: "iad1::qa123-1794060000000-abcdef123456",
      }),
    );
    const fields = jest.mocked(phLogger.info).mock.calls[0][1];
    if (failure === "read-active")
      expect(fields).toMatchObject({
        active_session_read_diagnostic_version: 1,
        active_session_read_error_kind: "file_not_found",
        active_session_read_http_status: 404,
      });
    else
      expect(fields).not.toHaveProperty(
        "active_session_read_diagnostic_version",
      );
    if (failure === "lookup")
      expect(fields).not.toHaveProperty("trigger_run_id");
    else
      expect(fields).toMatchObject({
        trigger_run_id: `run_${"a".repeat(26)}`,
        run_active: true,
        handoff_state: "recovery",
      });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

it.each(["", "read-active"])(
  "attributes verification failure without replaying a successful capture (%s)",
  async (failure) => {
    mockFailure = failure;
    mockRunActive = false;
    jest
      .mocked(getActiveBrowserSessionName)
      .mockResolvedValueOnce("default")
      .mockRejectedValueOnce(
        failure === "read-active"
          ? new BrowserPreviewUnavailable("loading")
          : new Error("PRIVATE verification"),
      );
    const response = await preview(false);
    expect(response.status).toBe(503);
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_get_unavailable",
      expect.objectContaining({
        failure_stage: "verify_active_session",
        preview_state: failure === "read-active" ? "loading" : "disconnected",
        run_active: false,
        ...(failure === "read-active" && {
          active_session_read_diagnostic_version: 1,
          active_session_read_error_kind: "file_not_found",
          active_session_read_http_status: 404,
        }),
      }),
    );
  },
);

it("does not add a failure diagnostic to an already closed browser", async () => {
  mockCapture.mockRejectedValueOnce(new BrowserPreviewUnavailable("closed"));
  expect((await preview(false)).status).toBe(410);
  expect(phLogger.info).not.toHaveBeenCalled();
});

it.each([
  ["PRIVATE_BUILD", "unknown"],
  ["A".repeat(40), "a".repeat(40)],
])("bounds correlation fields for build %s", async (build, expectedBuild) => {
  const prior = process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
  process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = build;
  try {
    expect(
      (await preview(true, "PRIVATE_HEADER?token=PRIVATE_TOKEN")).status,
    ).toBe(503);
    const fields = jest.mocked(phLogger.info).mock.calls[0][1];
    expect(fields).not.toHaveProperty("request_id");
    expect(fields).toMatchObject({ web_build_commit: expectedBuild });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  } finally {
    if (prior === undefined)
      delete process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT;
    else process.env.NEXT_PUBLIC_HACKERAI_BUILD_COMMIT = prior;
  }
});

it("keeps a successful frame when optional diagnostics are unavailable", async () => {
  mockFailure = "";
  expect((await preview(false)).status).toBe(200);
  expect(phLogger.info).not.toHaveBeenCalled();
});

it("contains asynchronous diagnostic delivery failure after the response", async () => {
  const response = await preview(false);
  expect(response.status).toBe(503);
  const callback = jest.mocked(after).mock.calls[0][0];
  expect(typeof callback).toBe("function");
  jest
    .mocked(phLogger.flush)
    .mockRejectedValueOnce(new Error("PRIVATE transport"));
  if (typeof callback === "function")
    await expect(callback()).resolves.toBeUndefined();
});

it("preserves a capture failure response when logging throws", async () => {
  jest.mocked(phLogger.info).mockImplementationOnce(() => {
    throw new Error("PRIVATE logging failure");
  });
  const result = await preview(false);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ state: "disconnected" });
});

it("adds capture suboperation context to the single existing GET failure event", async () => {
  mockCapture.mockImplementationOnce(async (...args: unknown[]) => {
    const observe = args[5] as (context: unknown) => void;
    observe({
      capture_stage: "frame_bridge",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 6,
      capture_open_receipt_version: 1,
      capture_open_receipt_status: "recorded",
      capture_open_phase: "completed",
      capture_open_exit_code: 0,
      capture_open_session_matches: true,
      capture_open_age: "older",
      capture_open_idle_env_version: 1,
      capture_open_idle_env: "15m",
    });
    throw new Error("PRIVATE frame stream");
  });
  const result = await preview(false);
  expect(result.status).toBe(503);
  expect(await result.json()).toEqual({ state: "disconnected" });
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "agent_browser_preview_get_unavailable",
    expect.objectContaining({
      failure_stage: "capture_frame",
      capture_stage: "frame_bridge",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 6,
      capture_open_receipt_version: 1,
      capture_open_receipt_status: "recorded",
      capture_open_phase: "completed",
      capture_open_exit_code: 0,
      capture_open_session_matches: true,
      capture_open_age: "older",
      capture_open_idle_env_version: 1,
      capture_open_idle_env: "15m",
    }),
  );
  expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
    "PRIVATE",
  );
});

const take = () =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
      }),
      body: jsonBody({ action: "take", browserSessionName: "default" }),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

const heartbeat = () =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
      }),
      body: jsonBody({ action: "heartbeat", grant: "g".repeat(32) }),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

it("reports only the remaining confirmed relay lease after renewal", async () => {
  const result = await heartbeat();
  expect(result.status).toBe(200);
  const data = await result.json();
  expect(data.state).toBe("human");
  expect(data.leaseValidForMs).toBeGreaterThan(0);
  expect(data.leaseValidForMs).toBeLessThanOrEqual(25_000);
  expect(Number.isFinite(data.processingDurationMs)).toBe(true);
  expect(data.processingDurationMs).toBeGreaterThanOrEqual(0);
  expect(mockRenewRelay).toHaveBeenCalledTimes(1);
});

it("does not renew a rejected grant", async () => {
  mockMutation.mockResolvedValueOnce(false);
  const result = await heartbeat();
  expect(result.status).toBe(409);
  expect(mockRenewRelay).not.toHaveBeenCalled();
});

it.each([
  ["auth", 401],
  ["lookup", 503],
])("distinguishes %s failure from lease expiry", async (failure, status) => {
  mockFailure = String(failure);
  const result = await heartbeat();
  expect(result.status).toBe(status);
  expect(mockRenewRelay).not.toHaveBeenCalled();
  expect(mockMutation).not.toHaveBeenCalled();
});

it.each(["identity", "capture", "claim"])(
  "keeps recovery paused after a %s failure",
  async (failure) => {
    mockFailure = failure;
    const response = await take();
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(mockPaused).toBe(true);
    expect(mockState).toBe("recovery");
    expect(mockPause.mock.calls.some(([, , paused]) => !paused)).toBe(false);
  },
);

it("restores an originally running Agent after a failed initial takeover", async () => {
  mockState = "agent";
  mockPaused = false;
  await take();
  expect(mockPaused).toBe(false);
  expect(mockState).toBe("agent");
});

it("admits takeover from the dedicated waiting state", async () => {
  mockState = "waiting";
  mockPaused = false;
  mockFailure = "none";
  expect((await take()).status).toBe(200);
  expect(mockPaused).toBe(true);
  expect(mockMutation.mock.calls.map(([name]) => name)).toEqual([
    "beginTakeoverForBackend",
    "finishTakeoverForBackend",
  ]);
  expect(mockStopRelay.mock.invocationCallOrder[0]).toBeLessThan(
    mockStartRelay.mock.invocationCallOrder[0],
  );
  expect(mockSendInput.mock.calls[0][3]).toEqual([
    {
      type: "input_mouse",
      eventType: "mouseReleased",
      x: 0,
      y: 0,
      button: "left",
    },
  ]);
  expect(mockSendInput.mock.invocationCallOrder[0]).toBeLessThan(
    mockCapture.mock.invocationCallOrder[0],
  );
});

it("keeps recovery when rollback cannot reopen the gate", async () => {
  mockState = "agent";
  mockPaused = false;
  mockFailure = "unpause";
  await take();
  expect(mockPaused).toBe(true);
  expect(mockState).toBe("recovery");
});

it("sends a validated input burst through one lease and rejects invalid bursts before input", async () => {
  mockState = "human";
  mockFailure = "none";
  const send = (inputs: unknown[]) =>
    post(
      {
        url: "https://preview.example/api/agent/browser/test",
        headers: new Headers({
          origin: "https://preview.example",
          "content-type": "application/json",
        }),
        body: jsonBody({ action: "input", grant: "g".repeat(43), inputs }),
      } as NextRequest,
      { params: Promise.resolve({ sessionId: mockSessionId }) },
    );
  const result = await send([
    { kind: "text", text: "A.b@C-d!" },
    { kind: "key", key: "Enter", code: "Enter" },
  ]);
  expect(result.status).toBe(200);
  expect(mockSendInput).toHaveBeenCalledTimes(1);
  expect(mockMutation.mock.calls.map(([name]) => name)).toEqual([
    "beginInputForBackend",
    "finishInputForBackend",
  ]);
  const rejected = await send([
    { kind: "text", text: "valid" },
    { kind: "cdp", method: "Network.getAllCookies" },
  ]);
  expect(rejected.status).toBe(400);
  expect(mockSendInput).toHaveBeenCalledTimes(1);
});

const exitTakeover = (note: unknown = "") =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
      }),
      body: jsonBody({
        action: "resume",
        requestId: "11111111-1111-4111-8111-111111111111",
        browserSessionName: "default",
        note,
      }),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

it("releases a disconnected fallback pointer before the resume snapshot", async () => {
  mockFailure = "none";
  expect((await exitTakeover()).status).toBe(200);
  expect(mockSendInput.mock.calls[0][3]).toEqual([
    {
      type: "input_mouse",
      eventType: "mouseReleased",
      x: 0,
      y: 0,
      button: "left",
    },
  ]);
  expect(mockStopRelay.mock.invocationCallOrder[0]).toBeLessThan(
    mockSendInput.mock.invocationCallOrder[0],
  );
  expect(mockSendInput.mock.invocationCallOrder[0]).toBeLessThan(
    mockCapture.mock.invocationCallOrder[0],
  );
});

it("keeps the Agent paused if pointer release fails during resume", async () => {
  mockFailure = "pointer-release";
  expect((await exitTakeover()).status).toBe(503);
  expect(mockPaused).toBe(true);
  expect(mockCapture).not.toHaveBeenCalled();
  expect(mockPause).not.toHaveBeenCalled();
  expect(
    mockMutation.mock.calls.some(([name]) => name === "saveExitNoteForBackend"),
  ).toBe(false);
});

it("saves even a blank note before unpausing and preserves the gate on save failure", async () => {
  mockFailure = "none";
  const result = await exitTakeover();
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    restart: false,
    continuation: { id: "saved-note" },
  });
  const savedCall = mockMutation.mock.calls.findIndex(
    ([name]) => name === "saveExitNoteForBackend",
  );
  expect(mockMutation.mock.invocationCallOrder[savedCall]).toBeLessThan(
    mockPause.mock.invocationCallOrder[0],
  );
  jest.clearAllMocks();
  mockPaused = true;
  mockFailure = "save";
  expect((await exitTakeover("I signed in")).status).toBe(503);
  expect(mockPause).not.toHaveBeenCalled();
  expect(mockPaused).toBe(true);
});

it("returns a persisted continuation after the run ends without touching its old browser", async () => {
  mockRunActive = false;
  mockState = "closed";
  const result = await exitTakeover("Selected the XSS lab");
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    restart: true,
    continuation: { id: "saved-note" },
  });
  expect(mockPause).not.toHaveBeenCalled();
  expect(mockMutation.mock.calls.map(([name]) => name)).toEqual([
    "saveExitNoteForBackend",
  ]);
});

it.each([null, 42, { text: "hello" }, "A".repeat(4001)])(
  "rejects malformed or oversized notes before saving or releasing control (%#)",
  async (note) => {
    mockFailure = "none";
    expect((await exitTakeover(note)).status).toBe(400);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockPause).not.toHaveBeenCalled();
  },
);

it("allows retry after an active run finished resuming without unpausing twice", async () => {
  mockFailure = "none";
  mockState = "agent";
  const result = await exitTakeover("A.b@C-d! 日本語 😀");
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({
    restart: false,
    continuation: { id: "saved-note" },
  });
  expect(mockMutation.mock.calls.map(([name]) => name)).toEqual([
    "saveExitNoteForBackend",
  ]);
  expect(mockPause).not.toHaveBeenCalled();
});

it("drains the relay before unpausing and stays paused if shutdown is unconfirmed", async () => {
  mockFailure = "none";
  expect((await exitTakeover()).status).toBe(200);
  expect(mockStopRelay.mock.invocationCallOrder[0]).toBeLessThan(
    mockPause.mock.invocationCallOrder[0],
  );
  jest.clearAllMocks();
  mockPaused = true;
  mockFailure = "relay-stop";
  expect((await exitTakeover()).status).toBe(503);
  expect(mockPause).not.toHaveBeenCalled();
  expect(mockPaused).toBe(true);
});

it.each(["agent", "recovery"])(
  "rolls back a failed relay start without committing takeover from %s",
  async (state) => {
    mockState = state;
    mockPaused = state === "recovery";
    mockFailure = "relay-start";
    expect((await take()).status).toBe(503);
    expect(mockMutation.mock.calls.map(([name]) => name)).not.toContain(
      "finishTakeoverForBackend",
    );
    expect(mockStopRelay).toHaveBeenCalled();
    expect(mockState).toBe(state);
    expect(mockPaused).toBe(state === "recovery");
  },
);

it("starts the relay while fresh capture is pending, but withholds control until both are ready", async () => {
  mockFailure = "none";
  let finish!: (frame: { image: string }) => void;
  mockCapture.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = take();
  // Flush asynchronous admission and sandbox setup, without waiting on capture.
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(mockStartRelay).toHaveBeenCalled();
  expect(
    mockMutation.mock.calls.some(
      ([name]) => name === "finishTakeoverForBackend",
    ),
  ).toBe(false);
  finish({ image: "fresh" });
  expect((await pending).status).toBe(200);
});

it("drains late relay startup before rollback after capture fails", async () => {
  mockState = "agent";
  mockPaused = false;
  let finish!: (url: string) => void;
  mockStartRelay.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = take();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(mockStartRelay).toHaveBeenCalled();
  // Old grants were drained before this startup; rollback of the new relay
  // must still wait for its outstanding startup to settle.
  expect(mockStopRelay).toHaveBeenCalledTimes(1);
  expect(mockStopRelay.mock.invocationCallOrder[0]).toBeLessThan(
    mockStartRelay.mock.invocationCallOrder[0],
  );
  expect(mockPaused).toBe(true);
  finish("https://relay.example");
  expect((await pending).status).toBe(503);
  expect(mockStopRelay).toHaveBeenCalledTimes(2);
  expect(mockPaused).toBe(false);
});

const resize = (width: unknown, height: unknown) =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
      }),
      body: jsonBody({
        action: "viewport",
        grant: "g".repeat(43),
        width,
        height,
      }),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

it("resizes the granted browser under the existing input lease", async () => {
  mockFailure = "";
  const result = await resize(390, 844);
  expect(result.status).toBe(200);
  expect(await result.json()).toEqual({ frame: { image: "resized" } });
  expect(mockMutation).toHaveBeenCalledWith(
    "beginInputForBackend",
    expect.objectContaining({ grant: "g".repeat(43) }),
  );
  expect(mockResize).toHaveBeenCalledWith(
    {},
    expect.anything(),
    "default",
    390,
    844,
  );
  expect(mockMutation).toHaveBeenCalledWith(
    "finishInputForBackend",
    expect.anything(),
  );
});
it.each([
  [239, 844],
  [390, 2561],
  ["390", 844],
  [390.5, 844],
])(
  "rejects invalid viewport %s x %s before touching the sandbox",
  async (width, height) => {
    expect((await resize(width, height)).status).toBe(400);
    expect(mockResize).not.toHaveBeenCalled();
  },
);
it("refuses resize when the grant is no longer current", async () => {
  mockMutation.mockResolvedValueOnce(false);
  expect((await resize(390, 844)).status).toBe(409);
  expect(mockResize).not.toHaveBeenCalled();
});
it("refuses resize after browser session selection changes", async () => {
  mockFailure = "identity";
  expect((await resize(390, 844)).status).toBe(409);
  expect(mockResize).not.toHaveBeenCalled();
  expect(mockMutation).toHaveBeenCalledWith(
    "finishInputForBackend",
    expect.anything(),
  );
});

it.each([undefined, "1"])(
  "rejects oversized streamed bodies despite Content-Length=%s",
  async (length) => {
    const cancel = jest.fn();
    const headers = new Headers({
      origin: "https://preview.example",
      "content-type": "application/json",
    });
    if (length) headers.set("content-length", length);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"note":"'));
        controller.enqueue(new TextEncoder().encode("é".repeat(5000)));
      },
      cancel,
    });
    const response = await post(
      {
        url: "https://preview.example/api/agent/browser/test",
        headers,
        body,
      } as NextRequest,
      { params: Promise.resolve({ sessionId: mockSessionId }) },
    );
    expect(response.status).toBe(413);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(mockMutation).not.toHaveBeenCalled();
  },
);

const diagnosticPost = (body: Record<string, unknown>) =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
        "x-vercel-id": "iad1::qa123-1794060000000-abcdef123456",
      }),
      body: jsonBody(body),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

it.each(["take", "resume"])(
  "preserves %s rollback and attaches the existing capture helper's finite failure context",
  async (action) => {
    const context = {
      capture_stage: "stream_status",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 3,
      capture_deadline_diagnostic_version: 1,
      capture_deadline_phase: "awaiting_response",
    };
    mockCapture.mockImplementationOnce(async (...args) => {
      const observe = args[5];
      if (typeof observe === "function") observe(context);
      throw new Error("PRIVATE capture output and frame");
    });
    const response = await diagnosticPost({
      action,
      browserSessionName: "default",
      grant: "PRIVATE_GRANT".repeat(3),
      note: "PRIVATE_NOTE",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "disconnected" });
    expect(mockMutation).toHaveBeenCalledWith(
      action === "take" ? "abortTakeoverForBackend" : "abortResumeForBackend",
      expect.any(Object),
    );
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_post_unavailable",
      expect.objectContaining({
        action,
        failure_stage: "capture_frame",
        post_capture_diagnostic_version: 1,
        post_capture_context_status: "recorded",
        ...context,
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toMatch(
      /PRIVATE|default/,
    );
  },
);

it("distinguishes the resume frame-age guard from a capture helper failure", async () => {
  mockFailure = "";
  mockCapture.mockImplementationOnce(async () => ({
    image: "PRIVATE_FRAME",
    capturedAt: Date.now() - 16_000,
  }));
  const response = await diagnosticPost({
    action: "resume",
    browserSessionName: "default",
    requestId: "11111111-1111-4111-8111-111111111111",
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ state: "disconnected" });
  expect(phLogger.info).toHaveBeenCalledWith(
    "agent_browser_preview_post_unavailable",
    expect.objectContaining({
      failure_stage: "capture_frame",
      post_capture_diagnostic_version: 1,
      post_capture_context_status: "frame_age_guard",
    }),
  );
  const fields = jest.mocked(phLogger.info).mock.calls[0][1];
  expect(fields).not.toHaveProperty("capture_stage");
  expect(JSON.stringify(fields)).not.toContain("PRIVATE");
});

it.each([
  ["take", "lookup", "resolve_session", "disconnected"],
  ["take", "connect", "connect_sandbox", "disconnected"],
  ["take", "read-active", "read_active_session", "loading"],
  ["take", "capture", "capture_frame", "disconnected"],
  ["take", "relay-start", "start_relay", "disconnected"],
  ["resume", "capture", "capture_frame", "disconnected"],
  ["viewport", "connect", "connect_sandbox", "disconnected"],
  ["release", "relay-stop", "drain_relays", "recovery"],
  ["heartbeat", "renew", "renew_relay", "recovery"],
])(
  "preserves %s/%s POST503 and records its bounded stage",
  async (action, failure, stage, state) => {
    mockFailure = failure;
    if (failure === "renew")
      mockRenewRelay.mockRejectedValueOnce(new Error("PRIVATE renewal"));
    const response = await diagnosticPost({
      action,
      browserSessionName: "default",
      grant: "PRIVATE_GRANT".repeat(3),
      note: "PRIVATE_NOTE",
      width: 390,
      height: 844,
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state });
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_post_unavailable",
      expect.objectContaining({
        diagnostic_version: 1,
        action,
        failure_stage: stage,
        preview_state: state,
        request_id: "iad1::qa123-1794060000000-abcdef123456",
        browser_session_id: mockSessionId,
      }),
    );
    const fields = jest.mocked(phLogger.info).mock.calls[0][1];
    expect(Object.keys(fields).sort()).toEqual(
      (failure === "lookup"
        ? [
            "diagnostic_version",
            "action",
            "failure_stage",
            "failure_kind",
            "preview_state",
            "web_build_commit",
            "request_id",
            "browser_session_id",
          ]
        : [
            "diagnostic_version",
            "action",
            "failure_stage",
            "failure_kind",
            "preview_state",
            "web_build_commit",
            "request_id",
            "browser_session_id",
            "handoff_state",
            "run_active",
            "trigger_run_id",
          ]
      )
        .concat(
          failure === "capture"
            ? ["post_capture_diagnostic_version", "post_capture_context_status"]
            : [],
          failure === "renew"
            ? [
                "relay_renew_diagnostic_version",
                "relay_renew_error_kind",
                "relay_renew_command_exit_code",
                "relay_renew_failure_reason",
              ]
            : [],
          failure === "relay-stop"
            ? [
                "relay_stop_diagnostic_version",
                "relay_stop_error_kind",
                "relay_stop_http_status",
                "relay_stop_command_exit_code",
              ]
            : [],
        )
        .sort(),
    );
    if (failure === "renew") {
      expect(fields).toMatchObject({
        relay_renew_diagnostic_version: 2,
        relay_renew_failure_reason: "lock_busy",
      });
    }
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|default/);
  },
);

it.each(["take", "resume", "release"])(
  "records bounded relay stop context on %s without changing its recovery response",
  async (action) => {
    mockFailure = "";
    const original = new Error("PRIVATE relay await failure");
    mockStopRelay.mockRejectedValueOnce(original);
    const receipt = {
      relay_stop_diagnostic_version: 1,
      relay_stop_error_kind: "command_exit",
      relay_stop_http_status: "none",
      relay_stop_command_exit_code: 1,
      relay_stop_receipt_version: 1,
      relay_stop_receipt_status: "recorded",
      relay_stop_first_failure: "filesystem",
      relay_stop_first_filesystem_stage: "write_revoked",
      relay_stop_first_filesystem_code: "permission",
      relay_stop_drain_deadline_count: 0,
      relay_stop_filesystem_failure_count: 1,
    };
    mockStopContext.mockReturnValueOnce(receipt);
    const response = await diagnosticPost({
      action,
      browserSessionName: "default",
      grant: "PRIVATE_GRANT".repeat(3),
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      state: action === "release" ? "recovery" : "disconnected",
    });
    expect(mockStopContext).toHaveBeenCalledTimes(1);
    expect(mockStopContext).toHaveBeenCalledWith(original);
    // Take's existing rollback drains the attempted grant a second time.
    expect(mockStopRelay).toHaveBeenCalledTimes(action === "take" ? 2 : 1);
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_post_unavailable",
      expect.objectContaining({
        action,
        failure_stage: "drain_relays",
        ...receipt,
      }),
    );
    expect(
      JSON.stringify(jest.mocked(phLogger.info).mock.calls[0][1]),
    ).not.toContain("PRIVATE");
  },
);

it("preserves the original unavailable event when optional stop projection throws", async () => {
  mockFailure = "relay-stop";
  mockStopContext.mockImplementationOnce(() => {
    throw new Error("PRIVATE observer");
  });
  const response = await diagnosticPost({
    action: "release",
    grant: "PRIVATE_GRANT".repeat(3),
  });
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ state: "recovery" });
  expect(phLogger.info).toHaveBeenCalledWith(
    "agent_browser_preview_post_unavailable",
    expect.objectContaining({
      failure_stage: "drain_relays",
      action: "release",
    }),
  );
  const fields = jest.mocked(phLogger.info).mock.calls[0][1];
  expect(fields).not.toHaveProperty("relay_stop_diagnostic_version");
  expect(JSON.stringify(fields)).not.toContain("PRIVATE");
});

it("does not project stop context for a different await failure", async () => {
  mockFailure = "connect";
  const response = await diagnosticPost({
    action: "take",
    browserSessionName: "default",
  });
  expect(response.status).toBe(503);
  expect(mockStopContext).not.toHaveBeenCalled();
  expect(jest.mocked(phLogger.info).mock.calls[0][1]).not.toHaveProperty(
    "relay_stop_diagnostic_version",
  );
});

it.each(["auth", "identity", "missing"])(
  "does not report non503 POST %s as unavailable",
  async (failure) => {
    mockFailure = failure;
    const response = await take();
    expect([401, 404, 410]).toContain(response.status);
    expect(phLogger.info).not.toHaveBeenCalled();
  },
);

it("bounds an unknown action and preserves POST503 when its diagnostic sink throws", async () => {
  mockFailure = "lookup";
  const response = await diagnosticPost({
    action: "PRIVATE_ACTION",
    note: "PRIVATE_NOTE",
  });
  expect(response.status).toBe(503);
  expect(phLogger.info).toHaveBeenCalledWith(
    "agent_browser_preview_post_unavailable",
    expect.objectContaining({ action: "unknown" }),
  );
  expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
    "PRIVATE",
  );
  jest.mocked(phLogger.info).mockImplementationOnce(() => {
    throw new Error("PRIVATE sink");
  });
  const failedSink = await take();
  expect(failedSink.status).toBe(503);
  expect(await failedSink.json()).toEqual({ state: "disconnected" });
});

it.each(["take", "resume", "input"])(
  "forwards %s input failure context while preserving rollback and HTTP503",
  async (action) => {
    mockFailure = "";
    mockState = action === "input" ? "human" : "recovery";
    const context = {
      input_diagnostic_version: 1,
      input_stage: "wait_bridge",
      input_error_kind: "command_exit",
      input_http_status: "none",
      input_command_exit_code: 6,
    };
    mockSendInput.mockImplementationOnce(async (...args) => {
      const observe = args[5];
      if (typeof observe === "function") observe(context);
      throw new Error("PRIVATE_INPUT_PASSWORD");
    });
    const response = await diagnosticPost({
      action,
      browserSessionName: "default",
      grant: "g".repeat(43),
      inputs: [{ kind: "text", text: "PRIVATE_PASSWORD" }],
      note: "PRIVATE_NOTE",
      requestId: "11111111-1111-4111-8111-111111111111",
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state: "disconnected" });
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_post_unavailable",
      expect.objectContaining({
        action,
        failure_stage: action === "input" ? "send_input" : "release_pointer",
        post_input_diagnostic_version: 1,
        post_input_context_status: "recorded",
        ...context,
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toMatch(
      /PRIVATE|default/,
    );
    expect(mockMutation).toHaveBeenCalledWith(
      action === "take"
        ? "abortTakeoverForBackend"
        : action === "resume"
          ? "abortResumeForBackend"
          : "finishInputForBackend",
      expect.any(Object),
    );
    expect(mockSendInput).toHaveBeenCalledTimes(1);
  },
);

const noRelayExit = {
  relay_renew_diagnostic_version: 2,
  relay_renew_error_kind: "other_error",
  relay_renew_command_exit_code: "none",
};
const poisonedGetter = jest.fn(() => {
  throw new Error("PRIVATE getter");
});

it.each<{
  label: string;
  error: () => unknown;
  command: Record<string, unknown>;
  state: string;
  expected: Record<string, unknown>;
}>([
  {
    label: "fetch transport reset",
    error: () =>
      Object.freeze(
        new TypeError("fetch failed", {
          cause: Object.assign(new Error("PRIVATE_CAUSE"), {
            code: "ECONNRESET",
          }),
        }),
      ),
    command: noRelayExit,
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "other_error",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: "none",
      post_stream_port_type_error_signal: "fetch_failed",
      post_stream_port_transport_code: "ECONNRESET",
    },
  },
  {
    label: "stream_status command exit",
    error: () => new Error("PRIVATE stdout /PRIVATE_BROWSER_DIRECTORY"),
    // A renewal-only reason for the same code must not relabel this read.
    command: {
      relay_renew_diagnostic_version: 2,
      relay_renew_error_kind: "command_exit",
      relay_renew_command_exit_code: 7,
      relay_renew_failure_reason: "lock_busy",
    },
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "command_exit",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: 7,
    },
  },
  {
    label: "SDK timeout",
    error: () => Object.assign(new Error("PRIVATE"), { name: "TimeoutError" }),
    command: { ...noRelayExit, relay_renew_error_kind: "timeout" },
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "timeout",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: "none",
    },
  },
  {
    label: "sandbox HTTP error",
    error: () =>
      Object.assign(new Error("PRIVATE"), {
        name: "SandboxError",
        statusCode: 502,
      }),
    command: noRelayExit,
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "sandbox_error",
      post_stream_port_http_status: 502,
      post_stream_port_command_exit_code: "none",
    },
  },
  {
    label: "unusable port guard",
    error: () => new BrowserPreviewUnavailable("loading"),
    command: noRelayExit,
    state: "loading",
    expected: {
      post_stream_port_error_kind: "preview_unavailable",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: "none",
    },
  },
  {
    label: "getter-rich TypeError",
    error: () =>
      Object.defineProperties(new TypeError(), {
        name: { get: poisonedGetter },
        message: { get: poisonedGetter },
        statusCode: { get: poisonedGetter },
        code: { get: poisonedGetter },
      }),
    command: noRelayExit,
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "other_error",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: "none",
      post_stream_port_type_error_signal: "unreadable",
      post_stream_port_transport_code: "unreadable",
    },
  },
  {
    label: "unreadable thrown proxy",
    error: () =>
      new Proxy(
        {},
        {
          getOwnPropertyDescriptor: () => {
            throw new Error("PRIVATE trap");
          },
        },
      ),
    command: { ...noRelayExit, relay_renew_error_kind: "thrown_value" },
    state: "disconnected",
    expected: {
      post_stream_port_error_kind: "unreadable_error",
      post_stream_port_http_status: "none",
      post_stream_port_command_exit_code: "none",
    },
  },
])(
  "adds bounded SDK context to the one TAKE read_stream_port 503 for $label",
  async ({ error, command, state, expected }) => {
    mockFailure = "";
    mockRenewContext.mockReturnValueOnce(command);
    mockStreamPort.mockRejectedValueOnce(error());
    const response = await take();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ state });
    expect(mockSendInput).not.toHaveBeenCalled();
    expect(mockCapture).not.toHaveBeenCalled();
    expect(mockStartRelay).not.toHaveBeenCalled();
    expect(mockMutation).toHaveBeenCalledWith(
      "abortTakeoverForBackend",
      expect.objectContaining({ paused: true }),
    );
    expect(mockPaused).toBe(true);
    expect(mockState).toBe("recovery");
    expect(phLogger.info).toHaveBeenCalledTimes(1);
    expect(phLogger.info).toHaveBeenCalledWith(
      "agent_browser_preview_post_unavailable",
      {
        diagnostic_version: 1,
        action: "take",
        failure_stage: "read_stream_port",
        failure_kind: expect.any(String),
        preview_state: state,
        web_build_commit: expect.any(String),
        browser_session_id: mockSessionId,
        handoff_state: "recovery",
        run_active: true,
        trigger_run_id: `run_${"a".repeat(26)}`,
        post_stream_port_diagnostic_version: 1,
        ...expected,
      },
    );
    expect(poisonedGetter).not.toHaveBeenCalled();
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toMatch(
      /PRIVATE|default|fetch failed/,
    );
  },
);

it("keeps a closed stream-status guard at 410 without a POST503 diagnostic", async () => {
  mockFailure = "";
  mockStreamPort.mockRejectedValueOnce(new BrowserPreviewUnavailable("closed"));
  const response = await take();
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ state: "closed" });
  expect(mockMutation).toHaveBeenCalledWith(
    "abortTakeoverForBackend",
    expect.objectContaining({ paused: true }),
  );
  expect(phLogger.info).not.toHaveBeenCalled();
});

it("preserves the stream-port 503 and Agent rollback when its projection throws", async () => {
  mockFailure = "";
  mockState = "agent";
  mockPaused = false;
  mockRenewContext.mockImplementationOnce(() => {
    throw new Error("PRIVATE projection");
  });
  mockStreamPort.mockRejectedValueOnce(new Error("PRIVATE stream"));
  const response = await take();
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ state: "disconnected" });
  expect(mockPaused).toBe(false);
  expect(mockState).toBe("agent");
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "agent_browser_preview_post_unavailable",
    expect.objectContaining({
      action: "take",
      failure_stage: "read_stream_port",
    }),
  );
  expect(jest.mocked(phLogger.info).mock.calls[0][1]).not.toHaveProperty(
    "post_stream_port_diagnostic_version",
  );
  expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
    "PRIVATE",
  );
});
