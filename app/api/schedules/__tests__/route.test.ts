jest.mock("next/server", () => ({
  NextRequest: class {
    method: string;
    nextUrl: URL;
    body?: string;
    constructor(url: string, init: any) {
      this.method = init.method;
      this.nextUrl = new URL(url);
      this.body = init.body;
    }
    async json() {
      return this.body ? JSON.parse(this.body) : null;
    }
  },
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));
jest.mock("@/lib/auth/get-user-id", () => ({ getUserIDAndPro: jest.fn() }));
jest.mock("@/lib/errors", () => ({
  ChatSDKError: class extends Error {
    type: string;
    constructor(type: string) {
      super(type);
      this.type = type;
    }
    toResponse() {
      return { status: this.type.startsWith("unauthorized") ? 401 : 403 };
    }
  },
}));
jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: jest.fn(),
  assertUserCanMakeCostIncurringRequest: jest.fn(),
}));
jest.mock("@/lib/schedules/access", () => ({ canUseSchedules: jest.fn() }));
jest.mock("@/lib/schedules/reconcile", () => ({
  reconcileScheduleRuns: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({ query: mockQuery, mutation: mockMutation }),
}));
jest.mock("@/convex/_generated/api", () => ({
  api: {
    localSandbox: { listConnectionsForBackend: "computers" },
    schedules: {
      list: "list",
      hasAny: "hasAny",
      save: "save",
      setEnabled: "setEnabled",
      getForDispatch: "getForDispatch",
      remove: "remove",
      claim: "claim",
    },
  },
}));
import { NextRequest } from "next/server";
import { GET, POST, PATCH, DELETE } from "../route";
import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { canUseSchedules } from "@/lib/schedules/access";
import { assertUserCanMakeCostIncurringRequest } from "@/lib/suspensions";
import { ConvexError } from "convex/values";
import { ChatSDKError } from "@/lib/errors";
import { reconcileScheduleRuns } from "@/lib/schedules/reconcile";
const mockQuery = jest.fn(),
  mockMutation = jest.fn(),
  mockTrigger = jest.fn();
const request = (
  method: string,
  body?: unknown,
  url = "http://localhost/api/schedules",
) =>
  new NextRequest(url, {
    method,
    ...(body
      ? {
          body: JSON.stringify(body),
          headers: { "content-type": "application/json" },
        }
      : {}),
  });
const definition = {
  name: "A schedule",
  prompt: "hello",
  model: "default",
  timing: { type: "interval", minutes: 15 },
};
describe("schedule HTTP boundary", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (getUserIDAndPro as jest.Mock).mockResolvedValue({
      userId: "owner",
      subscription: "pro",
      organizationId: "org",
    });
    (canUseSchedules as jest.Mock).mockResolvedValue(true);
    mockMutation.mockImplementation((fn) =>
      Promise.resolve(
        fn === "claim" ? { id: "receipt", chatId: "c" } : "saved",
      ),
    );
    mockQuery.mockResolvedValue([]);
    mockTrigger.mockResolvedValue({ id: "dispatcher" });
  });
  it("requires authentication", async () => {
    (getUserIDAndPro as jest.Mock).mockRejectedValue(
      new ChatSDKError("unauthorized:auth"),
    );
    expect((await GET(request("GET"))).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "preserves management visibility for existing schedules when eligibility is disabled: %s",
    async (hasSchedules) => {
      (canUseSchedules as jest.Mock).mockResolvedValue(false);
      mockQuery.mockResolvedValue(hasSchedules);
      const response = await GET(
        request("GET", undefined, "http://localhost/api/schedules?access=1"),
      );
      expect(await response.json()).toEqual({
        enabled: false,
        visible: hasSchedules,
      });
      expect(mockQuery).toHaveBeenCalledWith(
        "hasAny",
        expect.objectContaining({ userId: "owner" }),
      );
    },
  );
  it("keeps the schedule list available when result reconciliation fails", async () => {
    (reconcileScheduleRuns as jest.Mock).mockRejectedValueOnce(
      Error("unavailable"),
    );
    const log = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await GET(request("GET"));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        enabled: true,
        schedules: [],
        computers: [],
      });
    } finally {
      log.mockRestore();
    }
  });
  it("rejects creation before database or Trigger when the flag is disabled", async () => {
    (canUseSchedules as jest.Mock).mockResolvedValue(false);
    expect((await POST(request("POST", definition))).status).toBe(403);
    expect(mockMutation).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });
  it("keeps safe pause and deletion available after rollback", async () => {
    (canUseSchedules as jest.Mock).mockResolvedValue(false);
    expect(
      (await PATCH(request("PATCH", { id: "s", action: "pause" }))).status,
    ).toBe(200);
    expect(
      (
        await DELETE(
          request("DELETE", undefined, "http://localhost/api/schedules?id=s"),
        )
      ).status,
    ).toBe(200);
    expect(
      (await PATCH(request("PATCH", { id: "s", action: "resume" }))).status,
    ).toBe(403);
  });
  it("uses the session owner and strips client-supplied authority", async () => {
    expect(
      (
        await POST(
          request("POST", {
            ...definition,
            userId: "intruder",
            organizationId: "other",
            sandboxPreference: "local",
            agentPermissionMode: "other",
          }),
        )
      ).status,
    ).toBe(201);
    expect(mockMutation).toHaveBeenCalledWith(
      "save",
      expect.objectContaining({
        userId: "owner",
        organizationId: "org",
        definition,
      }),
    );
  });
  it("does not run another user's schedule", async () => {
    mockQuery.mockResolvedValue({ userId: "other", revision: 1 });
    expect(
      (await PATCH(request("PATCH", { id: "s", action: "run" }))).status,
    ).toBe(404);
    expect(mockTrigger).not.toHaveBeenCalled();
  });
  it("rejects invalid recurrence without writing", async () => {
    expect(
      (
        await POST(
          request("POST", {
            ...definition,
            timing: { type: "interval", minutes: 1 },
          }),
        )
      ).status,
    ).toBe(400);
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("does not start a suspended user's request", async () => {
    (assertUserCanMakeCostIncurringRequest as jest.Mock).mockRejectedValueOnce(
      new ChatSDKError("forbidden:chat"),
    );
    expect((await POST(request("POST", definition))).status).toBe(403);
    expect(mockMutation).not.toHaveBeenCalled();
  });
  it("acknowledges Run now as queued, not completed", async () => {
    mockQuery.mockResolvedValue({ userId: "owner", revision: 3 });
    const response = await PATCH(
      request("PATCH", { id: "s", action: "run", revision: 99 }),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ accepted: true });
    expect(mockMutation).toHaveBeenCalledWith(
      "claim",
      expect.objectContaining({
        id: "s",
        userId: "owner",
        revision: 3,
        manual: true,
        queueOnly: true,
      }),
    );
  });
});

it("returns an immediate throttle error instead of promising another task", async () => {
  (getUserIDAndPro as jest.Mock).mockResolvedValue({
    userId: "owner",
    subscription: "pro",
  });
  (canUseSchedules as jest.Mock).mockResolvedValue(true);
  mockQuery.mockResolvedValue({ userId: "owner", revision: 1 });
  mockMutation.mockRejectedValueOnce(
    new ConvexError("Wait a minute before running this schedule again."),
  );
  const response = await PATCH(request("PATCH", { id: "s", action: "run" }));
  expect(response.status).toBe(429);
  expect(await response.json()).toMatchObject({
    message: expect.stringContaining("Wait a minute"),
  });
});
