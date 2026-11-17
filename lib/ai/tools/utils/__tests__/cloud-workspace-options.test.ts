/**
 * @jest-environment node
 */
import { Sandbox } from "@e2b/code-interpreter";
import { workspaceOptions } from "../cloud-workspace-options";

type MockChat = {
  id: string;
  user_id: string;
  active_trigger_run_id?: string;
  active_agent_approval_session_id?: string;
};

let mockChat: MockChat;
const mockRetrieve = jest.fn();
const mockCancel = jest.fn();
const mockSessionClose = jest.fn(async () => undefined);

jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: { list: jest.fn(), connect: jest.fn(), kill: jest.fn() },
}));
jest.mock("@/lib/rate-limit/redis", () => ({
  createRedisClient: () => ({
    mget: async (...keys: string[]) => keys.map(() => null),
    get: async () => null,
  }),
}));
jest.mock("@/lib/cloud-recovery/completed", () => ({
  reconcileCompletedRecovery: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("@trigger.dev/sdk", () => ({
  ApiError: class ApiError extends Error {},
  runs: {
    retrieve: (runId: string) => mockRetrieve(runId),
    cancel: (runId: string) => mockCancel(runId),
  },
  sessions: { close: (id: string) => mockSessionClose(id) },
}));
jest.mock("@/lib/db/actions", () => ({
  getActiveTriggerRunsForUser: async () => ({
    runs: mockChat.active_trigger_run_id
      ? [
          {
            chatId: mockChat.id,
            triggerRunId: mockChat.active_trigger_run_id,
            approvalSessionId: mockChat.active_agent_approval_session_id,
          },
        ]
      : [],
    hasMore: false,
  }),
  getChatById: async () => ({ ...mockChat }),
  setActiveTriggerRun: async ({ expectedRunId }: { expectedRunId: string }) => {
    if (mockChat.active_trigger_run_id !== expectedRunId) return "stale";
    mockChat.active_trigger_run_id = undefined;
    mockChat.active_agent_approval_session_id = undefined;
    return "updated";
  },
}));
jest.mock("@/lib/db/subagents", () => ({
  listActiveSubagentsForUser: async () => ({ runs: [], hasMore: false }),
}));

const originalEnv = process.env;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => undefined);
  process.env = {
    ...originalEnv,
    CONVEX_SERVICE_ROLE_KEY: "test-only-key",
    E2B_API_KEY: "test-us",
    E2B_EU_API_KEY: "test-eu",
    E2B_TEMPLATE: "",
    E2B_EU_TEMPLATE: "",
  };
  mockChat = {
    id: "chat-1",
    user_id: "owner",
    active_trigger_run_id: "run-1",
    active_agent_approval_session_id: "session-1",
  };
  jest.mocked(Sandbox.list).mockImplementation((options) => {
    const cluster = options?.domain ? "eu" : "us";
    return {
      hasNext: false,
      nextItems: async () => [
        {
          sandboxId: `${cluster}-workspace`,
          state: "paused",
          startedAt: "2026-11-01T00:00:00.000Z",
          metadata: {
            userID: "owner",
            e2bCluster: cluster,
            template: "terminal-agent-sandbox",
          },
        },
      ],
    } as never;
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  process.env = originalEnv;
});

it("offers retained workspaces after detaching an owned parent that Trigger reports canceled", async () => {
  mockRetrieve.mockResolvedValue({
    status: "CANCELED",
    metadata: { chatId: "chat-1", userId: "owner" },
  });

  await expect(workspaceOptions("owner", true)).resolves.toMatchObject({
    status: "selection_required",
    choices: [
      { id: "eu-workspace", region: "eu-central-1" },
      { id: "us-workspace", region: "us-east-1" },
    ],
  });
  expect(mockSessionClose).toHaveBeenCalledWith("session-1");
  expect(mockChat.active_trigger_run_id).toBeUndefined();
  expect(mockCancel).not.toHaveBeenCalled();
});

it.each([
  [
    "live",
    () =>
      mockRetrieve.mockResolvedValue({
        status: "WAITING",
        metadata: { chatId: "chat-1", userId: "owner" },
      }),
  ],
  [
    "unknown",
    () => mockRetrieve.mockRejectedValue(new Error("Trigger unavailable")),
  ],
])(
  "keeps waiting for a %s parent without changing it or reading inventory",
  async (_label, setup) => {
    setup();

    await expect(workspaceOptions("owner", true)).resolves.toEqual({
      status: "waiting",
      reason: "active_tasks",
    });
    expect(mockChat.active_trigger_run_id).toBe("run-1");
    expect(mockSessionClose).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(Sandbox.list).not.toHaveBeenCalled();
  },
);
