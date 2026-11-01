import type { NextRequest } from "next/server";
jest.mock("next/server", () => ({}));
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
  getUserIDAndPro: async () => ({ userId: "owner", subscription: "pro" }),
}));
jest.mock("@/lib/goals/server", () => ({
  goalServiceKey: () => "synthetic",
  goalEnabled: jest.fn(),
  reconcileGoal: jest.fn(),
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ mutation: mockMutation }),
}));
jest.mock("@/lib/db/actions", () => ({
  getChatById: (...args: unknown[]) => mockChat(...args),
}));
jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: (...args: unknown[]) => mockCancel(...args),
  closeAgentApprovalSession: jest.fn(),
}));
import { POST } from "../route";
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
