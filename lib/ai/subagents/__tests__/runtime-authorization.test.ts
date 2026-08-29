import {
  assertSubagentRuntimeAuthorized,
  guardSubagentToolExecutions,
} from "@/lib/ai/subagents/runtime-authorization";

const activeChild = {
  status: "running" as const,
  parent_trigger_run_id: "parent-run",
  trigger_run_id: "child-run",
};

describe("subagent runtime authorization", () => {
  it.each([
    "DELAYED",
    "DEQUEUED",
    "EXECUTING",
    "PENDING_VERSION",
    "QUEUED",
    "WAITING",
  ])("accepts a bound active child while its parent is %s", async (status) => {
    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => activeChild),
        retrieveParent: jest.fn(async () => ({ status })),
      }),
    ).resolves.toBeUndefined();
  });

  it.each(["completed", "failed", "canceled", "timed_out"] as const)(
    "rejects a %s persisted child before more work",
    async (status) => {
      await expect(
        assertSubagentRuntimeAuthorized({
          subagentId: "subagent-1",
          childTriggerRunId: "child-run",
          parentTriggerRunId: "parent-run",
          loadChild: jest.fn(async () => ({ ...activeChild, status })),
          retrieveParent: jest.fn(async () => ({ status: "EXECUTING" })),
        }),
      ).rejects.toThrow("authorization was revoked");
    },
  );

  it("rejects a child whose Trigger binding no longer matches", async () => {
    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => ({
          ...activeChild,
          trigger_run_id: "replacement-run",
        })),
        retrieveParent: jest.fn(async () => ({ status: "EXECUTING" })),
      }),
    ).rejects.toThrow("authorization was revoked");
  });

  it.each([
    "COMPLETED",
    "CANCELED",
    "FAILED",
    "CRASHED",
    "SYSTEM_FAILURE",
    "EXPIRED",
    "TIMED_OUT",
    "INTERRUPTED",
    "FUTURE_STATUS",
  ])("rejects a non-active parent with status %s", async (status) => {
    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => activeChild),
        retrieveParent: jest.fn(async () => ({ status })),
      }),
    ).rejects.toThrow("no longer active");
  });

  it("rejects finalization after authorization is revoked between checks", async () => {
    let parentStatus = "EXECUTING";
    const authorization = {
      subagentId: "subagent-1",
      childTriggerRunId: "child-run",
      parentTriggerRunId: "parent-run",
      loadChild: jest.fn(async () => activeChild),
      retrieveParent: jest.fn(async () => ({ status: parentStatus })),
    };

    await expect(
      assertSubagentRuntimeAuthorized(authorization),
    ).resolves.toBeUndefined();
    parentStatus = "INTERRUPTED";
    await expect(
      assertSubagentRuntimeAuthorized(authorization),
    ).rejects.toThrow("no longer active");
  });

  it("fails closed when either control-plane lookup fails", async () => {
    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => {
          throw new Error("Convex unavailable");
        }),
        retrieveParent: jest.fn(async () => ({ status: "EXECUTING" })),
      }),
    ).rejects.toThrow("Convex unavailable");

    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => activeChild),
        retrieveParent: jest.fn(async () => {
          throw new Error("Trigger unavailable");
        }),
      }),
    ).rejects.toThrow("Trigger unavailable");
  });

  it("authorizes immediately before executing every privileged tool", async () => {
    const authorize = jest.fn(async () => undefined);
    const execute = jest.fn(async (input: unknown) => input);
    const guarded = guardSubagentToolExecutions(
      {
        run_terminal_cmd: { execute } as never,
      },
      authorize,
    );

    await expect(
      guarded.run_terminal_cmd.execute?.({ cmd: "pwd" }, {
        toolCallId: "tool-1",
        messages: [],
        abortSignal: undefined,
      } as never),
    ).resolves.toEqual({ cmd: "pwd" });
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(authorize.mock.invocationCallOrder[0]).toBeLessThan(
      execute.mock.invocationCallOrder[0],
    );
  });

  it("does not execute a tool when authorization is revoked", async () => {
    const execute = jest.fn(async () => "unsafe");
    const guarded = guardSubagentToolExecutions(
      {
        file: { execute } as never,
      },
      async () => {
        throw new Error("revoked");
      },
    );

    await expect(
      guarded.file.execute?.({ operation: "write" }, {
        toolCallId: "tool-1",
        messages: [],
        abortSignal: undefined,
      } as never),
    ).rejects.toThrow("revoked");
    expect(execute).not.toHaveBeenCalled();
  });

  it("enforces read-only file capability after runtime authorization", async () => {
    const execute = jest.fn(async () => "written");
    const guarded = guardSubagentToolExecutions(
      { file: { execute } as never },
      async () => undefined,
      { canWriteFiles: false },
    );

    await expect(
      guarded.file.execute?.(
        { action: "write", path: "/tmp/result.txt", text: "unsafe" },
        {
          toolCallId: "tool-write",
          messages: [],
          abortSignal: undefined,
        } as never,
      ),
    ).rejects.toThrow("does not permit file writes");
    expect(execute).not.toHaveBeenCalled();
  });

  it("prevents browser-only workers from using the terminal as general shell authority", async () => {
    const execute = jest.fn(async () => "ran");
    const guarded = guardSubagentToolExecutions(
      { run_terminal_cmd: { execute } as never },
      async () => undefined,
      { canWriteFiles: false, browserCommandsOnly: true },
    );

    await expect(
      guarded.run_terminal_cmd.execute?.({ command: "rm -rf /tmp/project" }, {
        toolCallId: "tool-shell",
        messages: [],
        abortSignal: undefined,
      } as never),
    ).rejects.toThrow("only permits direct agent-browser commands");
    await expect(
      guarded.run_terminal_cmd.execute?.(
        { command: "agent-browser snapshot -i" },
        {
          toolCallId: "tool-browser",
          messages: [],
          abortSignal: undefined,
        } as never,
      ),
    ).resolves.toBe("ran");
  });
});
