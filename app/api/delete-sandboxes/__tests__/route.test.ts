import { getUserIDAndPro } from "@/lib/auth/get-user-id";
import { terminateCloudSandboxesForUser } from "@/lib/ai/tools/utils/cloud-sandbox";
import { getActiveTriggerRunsForUser } from "@/lib/db/actions";
import { cancelSubagentsForUserDeletion } from "@/lib/db/subagents";
import { closeAndCancelAgentResources } from "@/lib/api/agent-deletion-cleanup";
import { POST } from "../route";

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserIDAndPro: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/cloud-sandbox", () => ({
  terminateCloudSandboxesForUser: jest.fn(),
}));
jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: jest.fn(),
}));
jest.mock("@/lib/db/subagents", () => ({
  cancelSubagentsForUserDeletion: jest.fn(),
}));
jest.mock("@/lib/api/agent-deletion-cleanup", () => ({
  closeAndCancelAgentResources: jest.fn(),
}));

const mockGetUserIDAndPro = getUserIDAndPro as jest.MockedFunction<
  typeof getUserIDAndPro
>;
const mockTerminateCloudSandboxesForUser =
  terminateCloudSandboxesForUser as jest.MockedFunction<
    typeof terminateCloudSandboxesForUser
  >;
const mockGetActiveTriggerRunsForUser =
  getActiveTriggerRunsForUser as jest.MockedFunction<
    typeof getActiveTriggerRunsForUser
  >;
const mockCancelSubagentsForUserDeletion =
  cancelSubagentsForUserDeletion as jest.MockedFunction<
    typeof cancelSubagentsForUserDeletion
  >;
const mockCloseAndCancelAgentResources =
  closeAndCancelAgentResources as jest.MockedFunction<
    typeof closeAndCancelAgentResources
  >;

describe("POST /api/delete-sandboxes", () => {
  let debugSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeAll(() => {
    global.Response = class TestResponse {
      status: number;
      private body: string | null;

      constructor(body: string | null, init?: ResponseInit) {
        this.body = body;
        this.status = init?.status ?? 200;
      }

      async json() {
        return JSON.parse(this.body ?? "");
      }

      async text() {
        return this.body ?? "";
      }
    } as unknown as typeof Response;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    debugSpy = jest.spyOn(console, "debug").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserIDAndPro.mockResolvedValue({
      userId: "user_123",
      subscription: "pro",
    } as never);
    mockGetActiveTriggerRunsForUser.mockResolvedValue({
      runs: [
        {
          chatId: "chat_123",
          triggerRunId: "run_parent",
          approvalSessionId: "approval_123",
        },
      ],
      hasMore: false,
    });
    mockCancelSubagentsForUserDeletion.mockResolvedValue({
      triggerRunIds: ["run_child"],
      hasMore: false,
    });
    mockCloseAndCancelAgentResources.mockResolvedValue({
      canceledTriggerRuns: 2,
      closedApprovalSessions: 1,
    });
  });

  afterEach(() => {
    debugSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("returns no operational details after successful deletion", async () => {
    mockTerminateCloudSandboxesForUser.mockResolvedValue({
      total: 2,
      killed: 1,
      alreadyGone: 1,
    });

    const response = await POST({} as any);
    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
    expect(mockGetActiveTriggerRunsForUser).toHaveBeenCalledWith({
      userId: "user_123",
    });
    expect(mockCancelSubagentsForUserDeletion).toHaveBeenCalledWith(
      "user_123",
      "terminal-sandbox-deleted",
    );
    expect(mockCloseAndCancelAgentResources).toHaveBeenCalledWith(
      [
        {
          chatId: "chat_123",
          triggerRunId: "run_parent",
          approvalSessionId: "approval_123",
        },
        { chatId: "subagent", triggerRunId: "run_child" },
      ],
      "terminal-sandbox-deleted",
    );
    expect(mockTerminateCloudSandboxesForUser).toHaveBeenCalledWith("user_123");
    expect(
      mockCloseAndCancelAgentResources.mock.invocationCallOrder[0],
    ).toBeLessThan(
      mockTerminateCloudSandboxesForUser.mock.invocationCallOrder[0],
    );
  });

  it("stops before termination when active Agent cleanup is not bounded", async () => {
    mockGetActiveTriggerRunsForUser.mockResolvedValueOnce({
      runs: [],
      hasMore: true,
    });

    const response = await POST({} as any);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Too many active Agent runs to stop safely. Please retry deletion.",
    });
    expect(mockCancelSubagentsForUserDeletion).not.toHaveBeenCalled();
    expect(mockTerminateCloudSandboxesForUser).not.toHaveBeenCalled();
  });

  it("stops before termination when validation cleanup is not bounded", async () => {
    mockCancelSubagentsForUserDeletion.mockResolvedValueOnce({
      triggerRunIds: [],
      hasMore: true,
    });

    const response = await POST({} as any);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error:
        "Too many active validation runs to stop safely. Please retry deletion.",
    });
    expect(mockCloseAndCancelAgentResources).not.toHaveBeenCalled();
    expect(mockTerminateCloudSandboxesForUser).not.toHaveBeenCalled();
  });

  it("does not query or terminate sandboxes for free users", async () => {
    mockGetUserIDAndPro.mockResolvedValueOnce({
      userId: "user_free",
      subscription: "free",
    } as never);

    const response = await POST({} as any);

    expect(response.status).toBe(403);
    expect(mockGetActiveTriggerRunsForUser).not.toHaveBeenCalled();
    expect(mockTerminateCloudSandboxesForUser).not.toHaveBeenCalled();
  });

  it("still fails on unexpected kill errors", async () => {
    mockTerminateCloudSandboxesForUser.mockRejectedValueOnce(
      new Error("permission denied"),
    );

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to delete sandboxes" });
    expect(errorSpy).toHaveBeenCalledWith(
      "Error deleting sandboxes:",
      expect.any(Error),
    );
  });

  it("does not count transport-closure failures as deleted sandboxes", async () => {
    mockTerminateCloudSandboxesForUser.mockRejectedValueOnce(
      new Error("kill transport channel already closed"),
    );

    const response = await POST({} as any);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body).toEqual({ error: "Failed to delete sandboxes" });
    expect(errorSpy).toHaveBeenCalledWith(
      "Error deleting sandboxes:",
      expect.any(Error),
    );
  });
});
