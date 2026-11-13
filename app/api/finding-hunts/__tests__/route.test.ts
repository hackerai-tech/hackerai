/** @jest-environment node */
import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";

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
  getUserIDAndPro: (...args: unknown[]) => mockAuth(...args),
}));
jest.mock("@/lib/findings/hunt-policy", () => ({
  isFindingHuntsEnabled: (...args: unknown[]) => mockEnabled(...args),
}));
jest.mock("@/lib/findings/hunt-service", () => ({
  getFindingHuntHistory: (...args: unknown[]) => mockHistory(...args),
}));
import * as route from "../route";

const mockEnabled = jest.fn(),
  mockHistory = jest.fn(),
  mockAuth = jest.fn();

const get = (findingId: string | null) =>
  ({
    nextUrl: {
      searchParams: new URLSearchParams(findingId ? { findingId } : {}),
    },
  }) as unknown as NextRequest;

describe("/api/finding-hunts", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuth.mockResolvedValue({ userId: "owner", subscription: "pro" });
    mockEnabled.mockResolvedValue(true);
  });

  it("requires a signed-in user before reading anything", async () => {
    const unauthorized = new ChatSDKError("unauthorized:auth");
    const toResponse = jest
      .spyOn(unauthorized, "toResponse")
      .mockReturnValue({ status: 401 } as Response);
    mockAuth.mockRejectedValue(unauthorized);
    expect((await route.GET(get("finding-1"))).status).toBe(401);
    expect(toResponse).toHaveBeenCalled();
    expect(mockEnabled).not.toHaveBeenCalled();
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("returns only enabled:false and reads nothing when the rollout is off", async () => {
    mockEnabled.mockResolvedValue(false);
    const response = await route.GET(get("finding-1"));
    expect(await response.json()).toEqual({ enabled: false });
    expect(mockHistory).not.toHaveBeenCalled();
  });

  it("reads the signed-in owner's history for the finding", async () => {
    const hunts = [
      {
        hunt_id: "h1",
        chat_id: "chat-1",
        assistant_message_id: "m1",
        status: "finished",
        started_at: 1,
        candidates: [],
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
      hunts,
    });
    const response = await route.GET(get("finding-1"));
    expect(mockHistory).toHaveBeenCalledWith({
      userId: "owner",
      findingId: "finding-1",
    });
    expect(await response.json()).toEqual({
      enabled: true,
      chat_title: "Scan",
      hunts,
    });
  });

  it("hides findings the user can't read and rejects invalid IDs", async () => {
    mockHistory.mockResolvedValue({ available: false });
    expect((await route.GET(get("finding-other"))).status).toBe(404);
    expect((await route.GET(get(null))).status).toBe(400);
    expect((await route.GET(get("x".repeat(129)))).status).toBe(400);
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
