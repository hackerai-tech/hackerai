import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const createToken = jest.fn<any>();
const forToken = jest.fn<any>();
const setActiveWait = jest.fn<any>();
const captureEvent = jest.fn<any>();

jest.mock("@trigger.dev/sdk", () => ({
  wait: { createToken, forToken },
}));
jest.mock("@/lib/db/agent-user-wait", () => ({
  setActiveAgentUserWait: setActiveWait,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: captureEvent },
}));

const context = {
  chatId: "chat-1",
  userID: "user-1",
  triggerRunId: "run-1",
};

const execute = async (
  overrides: Record<string, unknown> = {},
  toolOptions: {
    abortRun?: () => void;
    beforeSuspend?: () => Promise<void>;
    revalidateAfterSuspend?: (toolCallId: string) => Promise<void>;
  } = {},
) => {
  const { createWaitForUserTool } = await import("../wait-for-user");
  const waitTool = createWaitForUserTool({ ...context, ...overrides } as any, {
    pauseActiveTime: jest.fn(),
    resumeActiveTime: jest.fn(),
    ...toolOptions,
  });
  return waitTool.execute?.({}, { toolCallId: "tool-1" } as any);
};

describe("wait_for_user", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createToken.mockResolvedValue({ id: "waitpoint-1" });
    setActiveWait.mockResolvedValue("acquired");
    forToken.mockResolvedValue({
      ok: true,
      output: {
        chatId: "chat-1",
        userId: "user-1",
        runId: "run-1",
        toolCallId: "tool-1",
        replyId: "reply-1",
        text: "Option A",
      },
    });
  });

  it("parks the current run, returns the matching reply, and clears the wait", async () => {
    const abortRun = jest.fn();
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: true,
      wait_outcome: "message_arrived",
      reply: "Option A",
    });
    expect(createToken).toHaveBeenCalledWith({
      idempotencyKey: "agent-user-wait:run-1:tool-1",
      timeout: "3h",
    });
    expect(setActiveWait).toHaveBeenNthCalledWith(1, {
      chatId: "chat-1",
      userId: "user-1",
      runId: "run-1",
      toolCallId: "tool-1",
      tokenId: "waitpoint-1",
    });
    expect(setActiveWait).toHaveBeenNthCalledWith(2, {
      chatId: "chat-1",
      userId: "user-1",
      runId: "run-1",
      toolCallId: "tool-1",
    });
    expect(captureEvent).toHaveBeenCalledWith(
      "agent_wait_for_user_started",
      expect.not.objectContaining({ reply: expect.anything() }),
    );
    expect(abortRun).not.toHaveBeenCalled();
  });

  it("refuses a reply for a different run", async () => {
    const abortRun = jest.fn();
    forToken.mockResolvedValue({
      ok: true,
      output: {
        chatId: "chat-1",
        userId: "user-1",
        runId: "another-run",
        toolCallId: "tool-1",
        text: "Option A",
      },
    });
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: false,
    });
    expect(setActiveWait).toHaveBeenCalledTimes(2);
    expect(abortRun).toHaveBeenCalledTimes(1);
  });

  it("does not park when a newer run owns the chat", async () => {
    setActiveWait.mockResolvedValue("stale");
    await expect(execute()).resolves.toMatchObject({ success: false });
    expect(forToken).not.toHaveBeenCalled();
  });

  it("reports timeout and releases the reply slot", async () => {
    const abortRun = jest.fn();
    forToken.mockResolvedValue({ ok: false, error: new Error("timed out") });
    await expect(execute({}, { abortRun })).resolves.toMatchObject({
      success: false,
      wait_outcome: "timed_out",
    });
    expect(setActiveWait).toHaveBeenCalledTimes(2);
    expect(abortRun).toHaveBeenCalledTimes(1);
  });

  it("aborts if preparation fails before the wait starts", async () => {
    const abortRun = jest.fn();
    const error = new Error("could not release the free-run lock");
    await expect(
      execute(
        {},
        {
          abortRun,
          beforeSuspend: async () => {
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(forToken).not.toHaveBeenCalled();
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });

  it("aborts if Trigger rejects while suspended", async () => {
    const abortRun = jest.fn();
    const error = new Error("waitpoint unavailable");
    forToken.mockRejectedValue(error);
    await expect(execute({}, { abortRun })).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });

  it("aborts if authorization changed before resuming", async () => {
    const abortRun = jest.fn();
    const error = new Error("entitlement changed");
    await expect(
      execute(
        {},
        {
          abortRun,
          revalidateAfterSuspend: async () => {
            throw error;
          },
        },
      ),
    ).rejects.toBe(error);
    expect(abortRun).toHaveBeenCalledTimes(1);
    expect(setActiveWait).toHaveBeenCalledTimes(2);
  });
});
