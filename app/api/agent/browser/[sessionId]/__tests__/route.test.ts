import type { NextRequest } from "next/server";

const mockSessionId = "a".repeat(32);
let mockState = "recovery";
let mockPaused = true;
let mockFailure = "capture";
const mockMutation = jest.fn(
  async (name: string, args: { paused?: boolean }) => {
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
jest.mock("@/lib/auth/get-user-id", () => ({ getUserID: async () => "owner" }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    query: async () => ({ sessionId: mockSessionId, state: mockState }),
    mutation: mockMutation,
  }),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn(), flush: jest.fn() },
}));
jest.mock("@/lib/ai/browser-handoff/server", () => ({
  BrowserPreviewUnavailable: class extends Error {
    constructor(public state: string) {
      super(state);
    }
  },
  connectBrowserSandbox: async () => ({}),
  getActiveBrowserSessionName: async () =>
    mockFailure === "identity" ? "another-browser" : "default",
  setAgentBrowserPaused: (...args: Parameters<typeof mockPause>) =>
    mockPause(...args),
  captureBrowserFrame: async () => {
    if (mockFailure === "capture" || mockFailure === "unpause")
      throw new Error("Capture failed");
    return { image: "fresh" };
  },
}));

let post: typeof import("../route").POST;
beforeAll(async () => {
  const original = process.env.CONVEX_SERVICE_ROLE_KEY;
  process.env.CONVEX_SERVICE_ROLE_KEY = "test-only-service-key";
  try {
    post = (await import("../route")).POST;
  } finally {
    if (original === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
    else process.env.CONVEX_SERVICE_ROLE_KEY = original;
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  mockState = "recovery";
  mockPaused = true;
  mockFailure = "capture";
});

const take = () =>
  post(
    {
      url: "https://preview.example/api/agent/browser/test",
      headers: new Headers({
        origin: "https://preview.example",
        "content-type": "application/json",
      }),
      json: async () => ({ action: "take", browserSessionName: "default" }),
    } as NextRequest,
    { params: Promise.resolve({ sessionId: mockSessionId }) },
  );

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

it("keeps recovery when rollback cannot reopen the gate", async () => {
  mockState = "agent";
  mockPaused = false;
  mockFailure = "unpause";
  await take();
  expect(mockPaused).toBe(true);
  expect(mockState).toBe("recovery");
});
