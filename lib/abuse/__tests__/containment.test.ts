jest.mock("server-only", () => ({}));
const mockInfo = jest.fn(),
  mockSnapshot = jest.fn(),
  mockList = jest.fn(),
  mockKill = jest.fn(),
  mockRetrieve = jest.fn(),
  mockCancel = jest.fn(),
  mockClose = jest.fn(),
  mockPersist = jest.fn(),
  mockState = jest.fn(),
  mockFence = jest.fn(),
  mockFinish = jest.fn();
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {
    getInfo: (...args: unknown[]) => mockInfo(...args),
    createSnapshot: (...args: unknown[]) => mockSnapshot(...args),
    listSnapshots: (...args: unknown[]) => ({
      nextItems: () => mockList(...args),
      hasNext: false,
    }),
    kill: (...args: unknown[]) => mockKill(...args),
  },
}));
jest.mock("e2b", () => ({
  NotFoundError: class NotFoundError extends Error {},
}));
jest.mock("@trigger.dev/sdk", () => ({
  runs: { retrieve: (...args: unknown[]) => mockRetrieve(...args) },
}));
jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: () => ({
    mutation: (...args: unknown[]) => mockPersist(...args),
  }),
  getConvexUrl: () => "https://preview.convex.cloud",
}));
jest.mock("@/lib/api/agent-approval-session", () => ({
  cancelAgentTriggerRun: (...args: unknown[]) => mockCancel(...args),
  closeAgentApprovalSession: (...args: unknown[]) => mockClose(...args),
}));
jest.mock("@/lib/ai/tools/utils/cloud-workspace-guard", () => ({
  readCloudWorkspaceState: (...args: unknown[]) => mockState(...args),
  claimCloudWorkspaceCleanup: (...args: unknown[]) => mockFence(...args),
}));
import { NotFoundError } from "e2b";
import {
  executeAbuseContainment,
  verifyContainmentTarget,
  prepareAbuseResolution,
} from "../containment";
const reference = "AB-123e4567-e89b-42d3-a456-426614174000";
function row(snapshotRequested = true) {
  return {
    reference,
    operationToken: "owner",
    containment: {
      userId: "subject",
      chatId: "chat",
      runId: "run_root",
      transport: "cloud",
      childRunIds: ["run_child"],
      sandboxId: "sandbox",
      region: "us-east-1",
      snapshotRequested,
      snapshotName: snapshotRequested
        ? `abuse-${reference.toLowerCase()}`
        : undefined,
      snapshotReviewPending: snapshotRequested,
      processState: "unconfirmed",
      triggerState: "unconfirmed",
      workspaceState: "unconfirmed",
    },
  } as any;
}
beforeEach(() => {
  for (const mock of [
    mockInfo,
    mockSnapshot,
    mockList,
    mockKill,
    mockRetrieve,
    mockCancel,
    mockClose,
    mockPersist,
    mockState,
    mockFence,
    mockFinish,
  ])
    mock.mockReset();
  mockInfo.mockResolvedValue({
    sandboxId: "sandbox",
    metadata: { userID: "subject" },
  });
  mockSnapshot.mockResolvedValue({
    snapshotId: "snapshot",
    names: [`fixtures/abuse-${reference.toLowerCase()}:v1`],
  });
  mockList.mockResolvedValueOnce([]).mockResolvedValue([
    {
      snapshotId: "snapshot",
      names: [`fixtures/abuse-${reference.toLowerCase()}:v1`],
    },
  ]);
  mockRetrieve.mockResolvedValue({ status: "CANCELED" });
  mockCancel.mockResolvedValue(true);
  mockClose.mockResolvedValue(true);
  mockPersist.mockResolvedValue(null);
  mockState.mockResolvedValue({
    phase: "e2b",
    destinationId: "sandbox",
    region: "us-east-1",
  });
  mockFence.mockResolvedValue({ finish: mockFinish });
  mockFinish.mockResolvedValue(undefined);
  mockKill.mockImplementation(async () => {
    mockInfo.mockRejectedValue(new NotFoundError());
    return true;
  });
});
test("saves requested preservation before killing only the selected sandbox; cancellation is root and children only", async () => {
  const order: string[] = [];
  mockPersist.mockImplementation(async (_fn, args) => {
    if (args.containment.snapshotId) order.push("saved-snapshot");
  });
  mockKill.mockImplementation(async (id) => {
    expect(id).toBe("sandbox");
    order.push("kill");
    mockInfo.mockRejectedValue(new NotFoundError());
  });
  await executeAbuseContainment(row(), "operator");
  expect(order.indexOf("saved-snapshot")).toBeLessThan(order.indexOf("kill"));
  expect(mockCancel.mock.calls.map((args) => args[0])).toEqual([
    "run_root",
    "run_child",
  ]);
  expect(mockFinish).toHaveBeenCalledWith(true);
  expect(mockPersist.mock.calls.at(-1)![1]).toMatchObject({
    finished: true,
    containment: {
      snapshotId: "snapshot",
      processState: "provider_stopped",
      triggerState: "stopped",
      workspaceState: "released",
    },
  });
});
test("does not collect a full workspace snapshot unless explicitly requested", async () => {
  await executeAbuseContainment(row(false), "operator");
  expect(mockSnapshot).not.toHaveBeenCalled();
  expect(mockList).not.toHaveBeenCalled();
  expect(mockKill).toHaveBeenCalledWith("sandbox", expect.any(Object));
});
test.each(["create", "persist"])(
  "requested snapshot %s failure keeps process stop unconfirmed and cancellation still runs",
  async (failure) => {
    if (failure === "create")
      mockSnapshot.mockRejectedValue(new Error("provider private"));
    else mockPersist.mockRejectedValueOnce(new Error("storage private"));
    const result = await executeAbuseContainment(row(), "operator");
    expect(result.processState).toBe("unconfirmed");
    expect(mockKill).not.toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalledWith("run_root");
    expect(mockFinish).toHaveBeenCalledWith(false);
  },
);
test("provider stop is not confirmed from a canceled Trigger status, or a failed workspace release", async () => {
  mockKill.mockRejectedValue(new Error("unavailable"));
  await executeAbuseContainment(row(), "operator");
  expect(mockPersist.mock.calls.at(-1)![1].containment).toMatchObject({
    triggerState: "stopped",
    processState: "unconfirmed",
  });
  mockKill.mockImplementation(async () => {
    mockInfo.mockRejectedValue(new NotFoundError());
  });
  mockFinish.mockRejectedValue(new Error("fence write failed"));
  mockList.mockResolvedValue([
    {
      snapshotId: "snapshot",
      names: [`fixtures/abuse-${reference.toLowerCase()}:v1`],
    },
  ]);
  await executeAbuseContainment(row(), "operator");
  expect(mockPersist.mock.calls.at(-1)![1].containment).toMatchObject({
    processState: "provider_stopped",
    workspaceState: "unconfirmed",
  });
});
test("retry after provider stop and fence release verifies stored preservation without killing again", async () => {
  const saved = row();
  saved.containment.snapshotId = "snapshot";
  mockInfo.mockRejectedValue(new NotFoundError());
  mockState.mockResolvedValue(null);
  mockList.mockReset().mockResolvedValue([
    {
      snapshotId: "snapshot",
      names: [`fixtures/abuse-${reference.toLowerCase()}:v1`],
    },
  ]);
  await executeAbuseContainment(saved, "operator");
  expect(mockSnapshot).not.toHaveBeenCalled();
  expect(mockKill).not.toHaveBeenCalled();
  expect(mockFence).not.toHaveBeenCalled();
  expect(mockPersist.mock.calls.at(-1)![1].containment.workspaceState).toBe(
    "released",
  );
});
test("local/desktop cancellation never asserts a provider or OS process stop", async () => {
  const local = row(false);
  local.containment = {
    ...local.containment,
    transport: "desktop",
    sandboxId: undefined,
    region: undefined,
    workspaceState: "not_applicable",
  };
  await executeAbuseContainment(local, "operator");
  expect(mockKill).not.toHaveBeenCalled();
  expect(mockPersist.mock.calls.at(-1)![1].containment.processState).toBe(
    "unconfirmed",
  );
});
test("ownership and environment mismatches are rejected before any provider mutation", async () => {
  mockRetrieve.mockResolvedValue({
    taskIdentifier: "agent-long",
    payload: { userId: "other", chatId: "chat" },
  });
  await expect(
    verifyContainmentTarget({
      userId: "subject",
      chatId: "chat",
      runId: "run_root",
    }),
  ).rejects.toThrow("identity mismatch");
  expect(mockFence).not.toHaveBeenCalled();
  expect(mockKill).not.toHaveBeenCalled();
});

test("emergency stop recovers a provider snapshot created before a lost storage response", async () => {
  const saved = row();
  saved.containment.snapshotRequested = false;
  mockList.mockReset().mockResolvedValue([
    {
      snapshotId: "orphan",
      names: [`fixtures/abuse-${reference.toLowerCase()}:v1`],
    },
  ]);
  await executeAbuseContainment(saved, "operator");
  expect(mockSnapshot).not.toHaveBeenCalled();
  expect(mockPersist.mock.calls.at(-1)![1].containment).toMatchObject({
    snapshotId: "orphan",
    snapshotReviewPending: false,
    processState: "provider_stopped",
  });
});
test("emergency stop retains an unresolved snapshot review when provider lookup is unavailable", async () => {
  const saved = row();
  saved.containment.snapshotRequested = false;
  mockList
    .mockReset()
    .mockRejectedValue(new Error("snapshot service unavailable"));
  await executeAbuseContainment(saved, "operator");
  expect(mockKill).toHaveBeenCalled();
  expect(mockPersist.mock.calls.at(-1)![1].containment).toMatchObject({
    snapshotReviewPending: true,
    snapshotName: `abuse-${reference.toLowerCase()}`,
    processState: "provider_stopped",
  });
});
test("an exonerated case restores its selected workspace without killing or restoring a snapshot", async () => {
  await prepareAbuseResolution(row(), "operator");
  expect(mockFinish).toHaveBeenCalledWith(false);
  expect(mockKill).not.toHaveBeenCalled();
  expect(mockSnapshot).not.toHaveBeenCalled();
  expect(mockPersist.mock.calls.at(-1)![1].containment).toMatchObject({
    workspaceState: "restored",
    processState: "unconfirmed",
  });
});
