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
jest.mock("@/lib/findings/retest-policy", () => ({
  isFindingRetestsEnabled: (...args: unknown[]) => mockEnabled(...args),
}));
jest.mock("@/lib/findings/agent-retest-service", () => ({
  getAgentRetestHistory: (...args: unknown[]) => mockHistory(...args),
}));
import * as route from "../route";

const mockEnabled = jest.fn(),
  mockHistory = jest.fn();

const get = (findingId: string | null) =>
  ({
    nextUrl: {
      searchParams: new URLSearchParams(findingId ? { findingId } : {}),
    },
  }) as unknown as NextRequest;

describe("/api/finding-retests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnabled.mockResolvedValue(true);
  });

  it("returns only enabled:false and reads nothing when the rollout is off", async () => {
    mockEnabled.mockResolvedValue(false);
    const response = await route.GET(get("finding-1"));
    expect(await response.json()).toEqual({ enabled: false });
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("reads the signed-in owner's history for the finding", async () => {
    const retests = [
      {
        retest_id: "r1",
        chat_id: "chat-1",
        assistant_message_id: "m1",
        status: "finished",
        outcome: "reproduced",
        started_at: 1,
      },
    ];
    mockHistory.mockResolvedValue({
      available: true,
      finding: {
        finding_id: "finding-1",
        chat_id: "chat-1",
        chat_title: "Scan",
        updated_at: 5,
      },
      retests,
    });
    const response = await route.GET(get("finding-1"));
    expect(mockHistory).toHaveBeenCalledWith({
      userId: "owner",
      findingId: "finding-1",
    });
    expect(await response.json()).toEqual({
      enabled: true,
      chat_title: "Scan",
      retests,
    });
  });

  it("hides findings the user can't read and rejects invalid IDs", async () => {
    mockHistory.mockResolvedValue({ available: false });
    expect((await route.GET(get("finding-other"))).status).toBe(404);
    expect((await route.GET(get(null))).status).toBe(400);
    expect(mockHistory).toHaveBeenCalledTimes(1);
  });

  it("fails closed without echoing errors", async () => {
    mockHistory.mockRejectedValue(new Error("secret detail"));
    const response = await route.GET(get("finding-1"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret detail",
    );
  });

  it("has no write or run endpoints", () => {
    expect(Object.keys(route).sort()).toEqual(["GET"]);
  });
});
