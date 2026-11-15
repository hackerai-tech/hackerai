/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const enabled = jest.fn<any>();
const history = jest.fn<any>();
const start = jest.fn<any>();
const complete = jest.fn<any>();
const logError = jest.fn<any>();
const logEvent = jest.fn<any>();
jest.mock("@/lib/findings/retest-policy", () => ({
  isFindingRetestsEnabled: (...args: unknown[]) => enabled(...args),
}));
jest.mock("@/lib/findings/agent-retest-service", () => ({
  getAgentRetestHistory: (...args: unknown[]) => history(...args),
  startAgentRetest: (...args: unknown[]) => start(...args),
  completeAgentRetest: (...args: unknown[]) => complete(...args),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    error: (...args: unknown[]) => logError(...args),
    event: (...args: unknown[]) => logEvent(...args),
  },
}));
// Evidence checks run the report tools' real verification; only report
// persistence, unused here, is replaced.
jest.mock("@/lib/findings/semantic-dedupe", () => ({
  createFindingWithDedupe: jest.fn(),
}));
jest.mock("@/lib/db/actions", () => ({
  listReports: jest.fn(),
  getReport: jest.fn(),
  updateFinding: jest.fn(),
}));

// Import after the mocks are registered; @jest/globals mocks are not hoisted
// above static imports.
const tools = () => import("../finding-retests");

const context = {
  userID: "user-1",
  chatId: "chat-1",
  assistantMessageId: "server-message",
  triggerRunId: "run_server",
} as any;
const options = { toolCallId: "t", messages: [] } as any;

const input = (overrides: Record<string, unknown> = {}) => ({
  finding_id: "finding-1",
  outcome: "inconclusive" as const,
  summary: "The tester session expired before the ownership check.",
  reproduction_steps: ["Request own invoice"],
  expected_result: "Own invoice loads, other account's is denied",
  observed_result: "Own invoice returned 401",
  limitations: ["Needs a fresh tester session"],
  ...overrides,
});

describe("Agent finding retest tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enabled.mockResolvedValue(true);
  });

  it("fail closed when the rollout is off", async () => {
    enabled.mockResolvedValue(false);
    const { createStartFindingRetest, createCompleteFindingRetest } =
      await tools();
    expect(
      await createStartFindingRetest(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false, error: "unavailable" });
    expect(
      await createCompleteFindingRetest(context).execute!(input(), options),
    ).toMatchObject({ success: false, error: "unavailable" });
    expect(start).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("records provenance from the server context, never from the model", async () => {
    start.mockResolvedValue({
      success: true,
      retest_id: "r1",
      duplicate: false,
    });
    const { createStartFindingRetest } = await tools();
    const result = await createStartFindingRetest(context).execute!(
      { finding_id: "finding-1", expected_updated_at: 42 },
      options,
    );
    expect(start).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      findingId: "finding-1",
      assistantMessageId: "server-message",
      triggerRunId: "run_server",
      expectedUpdatedAt: 42,
    });
    expect(result).toMatchObject({ success: true, retest_id: "r1" });
  });

  it("refuses to record without server message provenance", async () => {
    const { createStartFindingRetest, createCompleteFindingRetest } =
      await tools();
    const withoutMessage = { ...context, assistantMessageId: undefined };
    expect(
      await createStartFindingRetest(withoutMessage).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false });
    expect(
      await createCompleteFindingRetest(withoutMessage).execute!(
        input(),
        options,
      ),
    ).toMatchObject({ success: false });
    expect(start).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects unredacted secrets and unsupported not-reproduced claims before saving", async () => {
    const { createCompleteFindingRetest } = await tools();
    const tool = createCompleteFindingRetest(context);
    expect(
      await tool.execute!(
        input({ observed_result: "Cookie: session=4f9a8b7c6d5e4f3a2b1c" }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(
      await tool.execute!(
        input({ outcome: "not_reproduced", limitations: [] }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps file evidence unverified when no sandbox is connected", async () => {
    complete.mockResolvedValue({
      success: true,
      retest_id: "r1",
      duplicate: false,
    });
    const { createCompleteFindingRetest } = await tools();
    const result = await createCompleteFindingRetest(context, () => null)
      .execute!(
      input({ evidence_refs: ["/tmp/retest/own.txt", "terminal capture 3"] }),
      options,
    );
    const call = complete.mock.calls[0][0] as any;
    expect(call).toMatchObject({
      assistantMessageId: "server-message",
      triggerRunId: "run_server",
      retainedEvidenceRefs: ["terminal capture 3"],
      evidenceVerification: {
        checked_refs: [],
        unavailable_refs: ["/tmp/retest/own.txt"],
      },
    });
    expect(call.result.evidence_refs).toEqual([
      "/tmp/retest/own.txt",
      "terminal capture 3",
    ]);
    expect(call.environment).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      evidence_warning: expect.any(String),
    });
  });

  it("reads history only for reports in the current chat", async () => {
    history.mockResolvedValue({ available: false });
    const { createGetFindingRetests } = await tools();
    const result = await createGetFindingRetests(context).execute!(
      { finding_id: "finding-other" },
      options,
    );
    expect(history).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      findingId: "finding-other",
      limit: 5,
    });
    expect(result).toMatchObject({ success: false, error: "not_found" });
  });
});

describe("Agent finding retest failure tracking", () => {
  // Raw failures can carry report content, paths and credentials.
  const sensitive = [
    "finding-1",
    "sk-live-4f9a8b7c6d5e",
    "/tmp/retest/own.txt",
    "invoice",
    "tester session",
  ];
  const rawError = () =>
    Object.assign(
      new Error(
        "write failed for finding-1 at /tmp/retest/own.txt token=sk-live-4f9a8b7c6d5e",
      ),
      { cause: new Error("invoice tester session") },
    );
  const fileInput = () => input({ evidence_refs: ["/tmp/retest/own.txt"] });
  const throwing = (thrown: unknown) => () => {
    throw thrown;
  };

  beforeEach(() => {
    jest.resetAllMocks();
    enabled.mockResolvedValue(true);
  });

  const run = async (
    operation: "get" | "start" | "complete",
    {
      sandbox = () => null,
      evidence = false,
      signal,
    }: {
      sandbox?: () => any;
      evidence?: boolean;
      signal?: AbortSignal;
    } = {},
  ) => {
    const m = await tools();
    const opts = { ...options, abortSignal: signal };
    if (operation === "get")
      return m.createGetFindingRetests(context).execute!(
        { finding_id: "finding-1" },
        opts,
      );
    if (operation === "start")
      return m.createStartFindingRetest(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        opts,
      );
    return m.createCompleteFindingRetest(context, sandbox).execute!(
      evidence ? fileInput() : input(),
      opts,
    );
  };

  const cases: Array<{
    operation: "get" | "start" | "complete";
    tool: string;
    stage: string;
    failureKind: "error" | "non_error";
    arrange: () => Parameters<typeof run>[1] | void;
  }> = [
    {
      operation: "get",
      tool: "get_finding_retests",
      stage: "flag_check",
      failureKind: "error",
      arrange: () => {
        enabled.mockRejectedValue(rawError());
      },
    },
    {
      operation: "get",
      tool: "get_finding_retests",
      stage: "history_read",
      failureKind: "non_error",
      arrange: () => {
        history.mockRejectedValue("finding-1 sk-live-4f9a8b7c6d5e");
      },
    },
    {
      operation: "start",
      tool: "start_finding_retest",
      stage: "start_save",
      failureKind: "error",
      arrange: () => {
        start.mockRejectedValue(rawError());
      },
    },
    {
      operation: "start",
      tool: "start_finding_retest",
      stage: "success_telemetry",
      failureKind: "error",
      arrange: () => {
        start.mockResolvedValue({
          success: true,
          retest_id: "r1",
          duplicate: false,
        });
        logEvent.mockImplementation(throwing(rawError()));
      },
    },
    {
      operation: "complete",
      tool: "complete_finding_retest",
      stage: "evidence_preparation",
      failureKind: "error",
      arrange: () => ({ evidence: true, sandbox: throwing(rawError()) }),
    },
    {
      operation: "complete",
      tool: "complete_finding_retest",
      stage: "environment_derivation",
      failureKind: "non_error",
      arrange: () => ({ sandbox: throwing({ path: "/tmp/retest/own.txt" }) }),
    },
    {
      operation: "complete",
      tool: "complete_finding_retest",
      stage: "complete_save",
      failureKind: "non_error",
      arrange: () => {
        complete.mockRejectedValue(42);
      },
    },
  ];

  it.each(cases)(
    "reports $tool failures at $stage without raw content",
    async ({ operation, tool, stage, failureKind, arrange }) => {
      const result = await run(operation, arrange() ?? {});

      expect(result).toMatchObject({ success: false, error: "general" });
      expect(logError).toHaveBeenCalledTimes(1);
      const [message, fields] = logError.mock.calls[0] as [string, any];
      const { error, ...rest } = fields;
      expect(rest).toEqual({
        event: "finding_retest_tool_failed",
        operation: tool,
        stage,
        failure_kind: failureKind,
        userId: "user-1",
        chat_id: "chat-1",
        assistant_message_id: "server-message",
        trigger_run_id: "run_server",
      });
      // A fresh static exception keeps Error Tracking grouping bounded and
      // never carries the caught value or its cause.
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("FindingRetestToolError");
      expect(error.message).toBe("Finding retest tool failed");
      expect(error.cause).toBeUndefined();
      const reported = JSON.stringify([message, rest, error.stack]);
      for (const value of sensitive) expect(reported).not.toContain(value);
    },
  );

  it("omits an absent run ID from correlation", async () => {
    start.mockRejectedValue(rawError());
    const { createStartFindingRetest } = await tools();
    await createStartFindingRetest({
      ...context,
      triggerRunId: undefined,
    }).execute!({ finding_id: "finding-1", expected_updated_at: 1 }, options);
    const fields = logError.mock.calls[0][1] as Record<string, unknown>;
    expect(fields).not.toHaveProperty("trigger_run_id");
    expect(fields).toMatchObject({ assistant_message_id: "server-message" });
  });

  it("keeps the safe response and retry when the failure sink throws", async () => {
    logError.mockImplementation(throwing(new Error("sink down")));
    start.mockRejectedValueOnce(rawError()).mockResolvedValueOnce({
      success: true,
      retest_id: "r1",
      duplicate: true,
    });
    complete.mockRejectedValueOnce(rawError());

    expect(await run("start")).toEqual({
      success: false,
      error: "general",
      message:
        "The retest could not be recorded. Call start_finding_retest again once; it is safe to retry.",
    });
    expect(await run("start")).toMatchObject({
      success: true,
      retest_id: "r1",
      duplicate: true,
    });
    expect(await run("complete")).toEqual({
      success: false,
      error: "general",
      message:
        "The assessment could not be confirmed. Call complete_finding_retest again with identical content; it is safe to retry.",
    });
    history.mockRejectedValue(rawError());
    expect(await run("get")).toEqual({
      success: false,
      error: "general",
      message: "Retest history could not be read. Try again later.",
    });
    expect(logError).toHaveBeenCalledTimes(3);
  });

  it("rethrows cancellation without reporting a failure", async () => {
    const persistence = { get: history, start, complete };
    for (const operation of ["get", "start", "complete"] as const) {
      const controller = new AbortController();
      persistence[operation].mockImplementation(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      const thrown = await run(operation, { signal: controller.signal }).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBe(controller.signal.reason);
      expect(thrown).toBeDefined();
      expect(persistence[operation]).toHaveBeenCalled();
    }
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not report expected refusals as failures", async () => {
    const {
      createGetFindingRetests,
      createStartFindingRetest,
      createCompleteFindingRetest,
    } = await tools();
    enabled.mockResolvedValue(false);
    expect(await run("get")).toMatchObject({ error: "unavailable" });
    expect(await run("complete")).toMatchObject({ error: "unavailable" });

    enabled.mockResolvedValue(true);
    expect(
      await createStartFindingRetest({
        ...context,
        assistantMessageId: undefined,
      }).execute!({ finding_id: "finding-1", expected_updated_at: 1 }, options),
    ).toMatchObject({ error: "unavailable" });
    history.mockResolvedValue({ available: false });
    expect(
      await createGetFindingRetests(context).execute!(
        { finding_id: "finding-1" },
        options,
      ),
    ).toMatchObject({ error: "not_found" });
    start.mockResolvedValue({
      success: false,
      error: "conflict",
      message: "The report changed since get_report.",
    });
    expect(await run("start")).toMatchObject({ error: "conflict" });
    complete.mockResolvedValue({
      success: false,
      error: "not_found",
      message: "Retest provenance is unavailable.",
    });
    expect(await run("complete")).toMatchObject({ error: "not_found" });
    expect(
      await createCompleteFindingRetest(context).execute!(
        input({ outcome: "not_reproduced", limitations: [] }),
        options,
      ),
    ).toMatchObject({ error: "validation" });

    expect(logError).not.toHaveBeenCalled();
  });
});
