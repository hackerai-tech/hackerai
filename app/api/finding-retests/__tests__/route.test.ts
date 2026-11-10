/** @jest-environment node */
import type { NextRequest } from "next/server";

jest.mock("next/server", () => ({}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { warn: jest.fn() } }));
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
jest.mock("@/lib/findings/http-retest-policy", () => ({
  isHttpFindingRetestsEnabled: (...args: unknown[]) => mockEnabled(...args),
}));
jest.mock("@/lib/findings/http-retest-service", () => ({
  httpRetestEnvironmentRevision: () => "a".repeat(64),
  getHttpRetestState: (...args: unknown[]) => mockState(...args),
  saveHttpRetestRecipe: (...args: unknown[]) => mockSave(...args),
  runHttpRetest: (...args: unknown[]) => mockRun(...args),
}));
import { GET, POST, PUT } from "../route";

const mockEnabled = jest.fn(),
  mockState = jest.fn(),
  mockSave = jest.fn(),
  mockRun = jest.fn();

const get = (findingId: string | null) =>
  ({
    nextUrl: {
      searchParams: new URLSearchParams(findingId ? { findingId } : {}),
    },
  }) as unknown as NextRequest;
const body = (value: unknown) =>
  new Request("https://app.example.test/api/finding-retests", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  }) as NextRequest;

const runBody = (overrides: Record<string, unknown> = {}) => ({
  findingId: "finding-1",
  recipeVersion: 2,
  requestId: "request-0001",
  reviewedOrigin: "https://app.example.test",
  reviewedEnvironment: "a".repeat(64),
  authorized: true,
  credentials: { tester_token: "synthetic-secret" },
  ...overrides,
});

describe("/api/finding-retests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled.mockResolvedValue(true);
  });

  it("returns only enabled:false and reads nothing when the rollout is off", async () => {
    mockEnabled.mockResolvedValue(false);
    const response = await GET(get("finding-1"));
    expect(await response.json()).toEqual({ enabled: false });
    expect(mockState).not.toHaveBeenCalled();
    expect((await PUT(body({}))).status).toBe(403);
    expect((await POST(body(runBody()))).status).toBe(403);
    expect(mockSave).not.toHaveBeenCalled();
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("reads state for the authenticated owner without exposing the environment ID", async () => {
    mockState.mockResolvedValue({
      available: true,
      finding: {
        finding_id: "finding-1",
        chat_id: "chat-1",
        chat_title: "Scan",
        title: "IDOR",
        target: "https://app.example.test",
        sandbox_preference: "env-1234-private",
      },
      recipe: null,
      runs: [],
    });
    const response = await GET(get("finding-1"));
    expect(mockState).toHaveBeenCalledWith({
      userId: "owner",
      findingId: "finding-1",
    });
    const payload = await response.json();
    expect(payload).toMatchObject({
      enabled: true,
      environment: { kind: "local" },
    });
    expect(JSON.stringify(payload)).not.toContain("env-1234-private");
  });

  it("maps an unavailable finding to 404", async () => {
    mockState.mockResolvedValue({ available: false });
    expect((await GET(get("finding-1"))).status).toBe(404);
  });

  it("requires explicit authorization and a reviewed recipe to run", async () => {
    const { authorized: _omit, ...withoutAuthorization } = runBody();
    expect((await POST(body(withoutAuthorization))).status).toBe(400);
    expect((await POST(body(runBody({ authorized: false })))).status).toBe(400);
    expect((await POST(body(runBody({ requestId: "x" })))).status).toBe(400);
    expect(
      (await POST(body(runBody({ reviewedEnvironment: "x" })))).status,
    ).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("rejects oversized streamed input before dispatching it", async () => {
    const response = await POST(
      body(runBody({ credentials: { tester_token: "é".repeat(40_000) } })),
    );
    expect(response.status).toBe(400);
    expect(mockRun).not.toHaveBeenCalled();
  });

  it("runs as the authenticated user and maps conflicts", async () => {
    mockRun.mockResolvedValue({
      success: false,
      error: "busy",
      message: "A retest is already running for this finding.",
    });
    const response = await POST(body(runBody()));
    expect(response.status).toBe(409);
    expect(mockRun).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        subscription: "pro",
        credentials: { tester_token: "synthetic-secret" },
      }),
    );
    expect(JSON.stringify(await response.json())).not.toContain(
      "synthetic-secret",
    );
  });

  it("does not echo errors or credentials when the service fails", async () => {
    mockRun.mockRejectedValue(new Error("boom synthetic-secret"));
    const response = await POST(body(runBody()));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(
      "synthetic-secret",
    );
  });

  it("saves recipes as the user with the expected version", async () => {
    mockSave.mockResolvedValue({
      success: false,
      error: "conflict",
      message: "changed",
      current_version: 3,
    });
    const response = await PUT(
      body({ findingId: "finding-1", expectedVersion: 2, recipe: {} }),
    );
    expect(response.status).toBe(409);
    expect(mockSave).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "owner",
        expectedVersion: 2,
        source: "user",
      }),
    );
  });
});
