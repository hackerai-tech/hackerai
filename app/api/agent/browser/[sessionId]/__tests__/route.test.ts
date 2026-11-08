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
  getPrivateStreamPort: async () => 1234,
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
      ).sort(),
    );
    expect(JSON.stringify(fields)).not.toMatch(/PRIVATE|default/);
  },
);

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
