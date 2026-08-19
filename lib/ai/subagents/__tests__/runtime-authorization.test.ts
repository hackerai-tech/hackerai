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
  it("accepts a bound active child while its parent is non-terminal", async () => {
    await expect(
      assertSubagentRuntimeAuthorized({
        subagentId: "subagent-1",
        childTriggerRunId: "child-run",
        parentTriggerRunId: "parent-run",
        loadChild: jest.fn(async () => activeChild),
        retrieveParent: jest.fn(async () => ({ status: "EXECUTING" })),
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
  ])("rejects a terminal parent with status %s", async (status) => {
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
});
