/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const enabled = jest.fn<any>();
const history = jest.fn<any>();
const start = jest.fn<any>();
const record = jest.fn<any>();
const complete = jest.fn<any>();
const logError = jest.fn<any>();
const logEvent = jest.fn<any>();
jest.mock("@/lib/findings/hunt-policy", () => ({
  isFindingHuntsEnabled: (...args: unknown[]) => enabled(...args),
}));
jest.mock("@/lib/findings/hunt-service", () => ({
  getFindingHuntHistory: (...args: unknown[]) => history(...args),
  startFindingHunt: (...args: unknown[]) => start(...args),
  recordFindingHuntCandidate: (...args: unknown[]) => record(...args),
  completeFindingHunt: (...args: unknown[]) => complete(...args),
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
const tools = () => import("../finding-hunts");

const context = {
  userID: "user-1",
  chatId: "chat-1",
  assistantMessageId: "server-message",
  triggerRunId: "run_server",
} as any;
const options = { toolCallId: "t", messages: [] } as any;

const candidate = (overrides: Record<string, unknown> = {}) => ({
  finding_id: "finding-1",
  candidate_key: "invoice-export",
  surface: "POST /api/invoices/export",
  rationale: "Builds the CSV from the same invoice query.",
  outcome: "inconclusive" as const,
  evidence_basis: "runtime_check" as const,
  reproduction_steps: ["Request own export"],
  expected_result: "Only own invoices",
  observed_result: "403: role member can't export",
  limitations: ["Needs an admin test account"],
  ...overrides,
});
const completion = {
  finding_id: "finding-1",
  summary: "One sibling reproduced; export needs admin access.",
  limitations: ["History endpoint not reached"],
};

const savedCandidate = {
  success: true,
  hunt_id: "h1",
  candidate_count: 1,
  duplicate: false,
};
const savedHunt = {
  success: true,
  hunt_id: "h1",
  duplicate: false,
  counts: { reproduced: 1, ruled_out: 0, inconclusive: 1, not_examined: 0 },
};

describe("Finding hunt tools", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    enabled.mockResolvedValue(true);
  });

  it("refuses to start or read history when the rollout is off", async () => {
    enabled.mockResolvedValue(false);
    const { createStartFindingHunt, createGetFindingHunts } = await tools();
    expect(
      await createStartFindingHunt(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false, error: "unavailable" });
    expect(
      await createGetFindingHunts(context).execute!(
        { finding_id: "finding-1" },
        options,
      ),
    ).toMatchObject({ error: "unavailable" });
    expect(start).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it("lets an already started hunt save and finish after a mid-run disable", async () => {
    enabled.mockResolvedValue(false);
    record.mockResolvedValue(savedCandidate);
    complete.mockResolvedValue(savedHunt);
    const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
      await tools();
    expect(
      await createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      ),
    ).toMatchObject({ success: true });
    expect(
      await createCompleteFindingHunt(context).execute!(completion, options),
    ).toMatchObject({ success: true });
    // The server still checks the hunt's own live provenance on every write.
    expect(record.mock.calls[0][0]).toMatchObject({
      assistantMessageId: "server-message",
      triggerRunId: "run_server",
    });
  });

  it("records provenance from the server context, never from the model", async () => {
    start.mockResolvedValue({ success: true, hunt_id: "h1", duplicate: false });
    const { createStartFindingHunt } = await tools();
    const result = await createStartFindingHunt(context).execute!(
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
    expect(result).toMatchObject({ success: true, hunt_id: "h1" });
    expect(logEvent).toHaveBeenCalledWith("finding_hunt_started", {
      userId: "user-1",
    });
  });

  it("refuses to record without server message provenance", async () => {
    const { createStartFindingHunt, createRecordFindingHuntCandidate } =
      await tools();
    const withoutMessage = { ...context, assistantMessageId: undefined };
    expect(
      await createStartFindingHunt(withoutMessage).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false });
    expect(
      await createRecordFindingHuntCandidate(withoutMessage).execute!(
        candidate(),
        options,
      ),
    ).toMatchObject({ success: false });
    expect(start).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("rejects secrets and unsupported claims before saving", async () => {
    const { createRecordFindingHuntCandidate } = await tools();
    const tool = createRecordFindingHuntCandidate(context);
    expect(
      await tool.execute!(
        candidate({ observed_result: "Cookie: session=4f9a8b7c6d5e4f3a2b1c" }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(
      await tool.execute!(
        candidate({
          outcome: "reproduced",
          evidence_basis: "source_review_only",
        }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(record).not.toHaveBeenCalled();
  });

  it("requires a successful same-surface control before a runtime rule-out", async () => {
    record.mockResolvedValue(savedCandidate);
    const { createRecordFindingHuntCandidate } = await tools();
    const tool = createRecordFindingHuntCandidate(context);
    const blocked = candidate({
      candidate_key: "editor-preview",
      outcome: "ruled_out",
      observed_result: "403 for own and tester B's invoice",
    });
    for (const authorized_control_succeeded of [undefined, false]) {
      const result = (await tool.execute!(
        { ...blocked, authorized_control_succeeded },
        options,
      )) as any;
      expect(result).toMatchObject({ success: false, error: "validation" });
      expect(result.message).toMatch(/inconclusive/);
    }
    expect(record).not.toHaveBeenCalled();
    expect(
      await tool.execute!(
        { ...blocked, authorized_control_succeeded: true },
        options,
      ),
    ).toMatchObject({ success: true });
    expect((record.mock.calls[0][0] as any).candidate).toMatchObject({
      outcome: "ruled_out",
      authorized_control_succeeded: true,
    });
  });

  it("keeps file evidence unverified when no sandbox is connected", async () => {
    record.mockResolvedValue(savedCandidate);
    const { createRecordFindingHuntCandidate } = await tools();
    const result = await createRecordFindingHuntCandidate(context, () => null)
      .execute!(
      candidate({ evidence_refs: ["/tmp/hunt/export.txt", "terminal 4"] }),
      options,
    );
    const call = record.mock.calls[0][0] as any;
    expect(call).toMatchObject({
      retainedEvidenceRefs: ["terminal 4"],
      evidenceVerification: {
        checked_refs: [],
        unavailable_refs: ["/tmp/hunt/export.txt"],
      },
    });
    expect(call.candidate.evidence_refs).toEqual([
      "/tmp/hunt/export.txt",
      "terminal 4",
    ]);
    expect(result).toMatchObject({
      success: true,
      evidence_warning: expect.any(String),
    });
  });

  it("reports only content-free counts and outcomes in analytics", async () => {
    record.mockResolvedValue(savedCandidate);
    complete.mockResolvedValue(savedHunt);
    const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
      await tools();
    await createRecordFindingHuntCandidate(context).execute!(
      candidate(),
      options,
    );
    await createCompleteFindingHunt(context).execute!(completion, options);
    expect(logEvent).toHaveBeenCalledWith("finding_hunt_candidate_saved", {
      userId: "user-1",
      outcome: "inconclusive",
      candidate_count: 1,
    });
    expect(logEvent).toHaveBeenCalledWith("finding_hunt_completed", {
      userId: "user-1",
      reproduced: 1,
      ruled_out: 0,
      inconclusive: 1,
      not_examined: 0,
      candidate_count: 2,
    });
    expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(
      /invoice|export|finding-1|admin|sibling/i,
    );
    // Duplicate retries are not counted twice.
    logEvent.mockClear();
    record.mockResolvedValue({ ...savedCandidate, duplicate: true });
    await createRecordFindingHuntCandidate(context).execute!(
      candidate(),
      options,
    );
    expect(logEvent).not.toHaveBeenCalled();
  });

  describe("write order within one Agent response", () => {
    const deferred = <T>() => {
      let resolve!: (value: T) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
    const withCandidate = {
      ...savedHunt,
      counts: { reproduced: 0, ruled_out: 0, inconclusive: 1, not_examined: 0 },
    };

    it("never lets a completion overtake a candidate still being saved", async () => {
      const save = deferred<typeof savedCandidate>();
      record.mockReturnValue(save.promise);
      complete.mockResolvedValue(withCandidate);
      const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
        await tools();
      // The SDK starts both calls concurrently, in the model's order.
      const recording = createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      );
      const completing = createCompleteFindingHunt(context).execute!(
        completion,
        options,
      );
      await settle();
      expect(record).toHaveBeenCalledTimes(1);
      expect(complete).not.toHaveBeenCalled();

      save.resolve(savedCandidate);
      expect(await recording).toMatchObject({ success: true });
      expect(await completing).toMatchObject({
        success: true,
        counts: { inconclusive: 1 },
      });
      expect(complete).toHaveBeenCalledTimes(1);
    });

    it("keeps later writes going after an earlier one fails", async () => {
      record.mockRejectedValueOnce(new Error("save failed"));
      record.mockResolvedValueOnce(savedCandidate);
      complete.mockResolvedValue(withCandidate);
      const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
        await tools();
      const failing = createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      );
      const retry = createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      );
      const completing = createCompleteFindingHunt(context).execute!(
        completion,
        options,
      );
      expect(await failing).toMatchObject({ success: false, error: "general" });
      expect(await retry).toMatchObject({ success: true });
      expect(await completing).toMatchObject({ success: true });
    });

    it("doesn't block other findings or other responses", async () => {
      const save = deferred<typeof savedCandidate>();
      record.mockReturnValue(save.promise);
      complete.mockResolvedValue(savedHunt);
      const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
        await tools();
      const recording = createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      );
      await settle();
      // Another finding in this response.
      expect(
        await createCompleteFindingHunt(context).execute!(
          { ...completion, finding_id: "finding-2" },
          options,
        ),
      ).toMatchObject({ success: true });
      // The same finding from another response.
      expect(
        await createCompleteFindingHunt({ ...context }).execute!(
          completion,
          options,
        ),
      ).toMatchObject({ success: true });
      expect(complete).toHaveBeenCalledTimes(2);
      save.resolve(savedCandidate);
      await recording;
    });

    it("drops a queued write cancelled while it waited, without saving it", async () => {
      const save = deferred<typeof savedCandidate>();
      record.mockReturnValue(save.promise);
      const { createRecordFindingHuntCandidate, createCompleteFindingHunt } =
        await tools();
      const recording = createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      );
      const controller = new AbortController();
      const completing = Promise.resolve(
        createCompleteFindingHunt(context).execute!(completion, {
          ...options,
          abortSignal: controller.signal,
        }),
      ).then(
        () => undefined,
        (error: unknown) => error,
      );
      controller.abort();
      save.resolve(savedCandidate);
      await recording;
      expect(await completing).toBe(controller.signal.reason);
      expect(complete).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();
    });
  });

  it("reads history only for reports in the current chat", async () => {
    history.mockResolvedValue({ available: false });
    const { createGetFindingHunts } = await tools();
    const result = await createGetFindingHunts(context).execute!(
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

describe("Finding hunt failure tracking", () => {
  const sensitive = [
    "finding-1",
    "sk-live-4f9a8b7c6d5e",
    "/tmp/hunt/export.txt",
    "invoice",
    "tester session",
  ];
  const rawError = () =>
    Object.assign(
      new Error(
        "write failed for finding-1 at /tmp/hunt/export.txt token=sk-live-4f9a8b7c6d5e",
      ),
      { cause: new Error("invoice tester session") },
    );

  beforeEach(() => {
    jest.resetAllMocks();
    enabled.mockResolvedValue(true);
  });

  it.each([
    {
      tool: "start_finding_hunt",
      stage: "start_save",
      run: async (m: any) => {
        start.mockRejectedValue(rawError());
        return m
          .createStartFindingHunt(context)
          .execute(
            { finding_id: "finding-1", expected_updated_at: 1 },
            options,
          );
      },
    },
    {
      tool: "record_finding_hunt_candidate",
      stage: "candidate_save",
      run: async (m: any) => {
        record.mockRejectedValue("finding-1 sk-live-4f9a8b7c6d5e");
        return m
          .createRecordFindingHuntCandidate(context)
          .execute(candidate(), options);
      },
    },
    {
      tool: "record_finding_hunt_candidate",
      stage: "evidence_preparation",
      run: async (m: any) =>
        m
          .createRecordFindingHuntCandidate(context, () => {
            throw rawError();
          })
          .execute(
            candidate({ evidence_refs: ["/tmp/hunt/export.txt"] }),
            options,
          ),
    },
    {
      tool: "complete_finding_hunt",
      stage: "complete_save",
      run: async (m: any) => {
        complete.mockRejectedValue(rawError());
        return m
          .createCompleteFindingHunt(context)
          .execute(completion, options);
      },
    },
    {
      tool: "get_finding_hunts",
      stage: "history_read",
      run: async (m: any) => {
        history.mockRejectedValue(rawError());
        return m
          .createGetFindingHunts(context)
          .execute({ finding_id: "finding-1" }, options);
      },
    },
  ])(
    "reports $tool failures at $stage without raw content",
    async ({ tool, stage, run }) => {
      const result = await run(await tools());
      expect(result).toMatchObject({ success: false, error: "general" });
      expect(logError).toHaveBeenCalledTimes(1);
      const [message, fields] = logError.mock.calls[0] as [string, any];
      const { error, ...rest } = fields;
      expect(rest).toMatchObject({
        event: "finding_hunt_tool_failed",
        operation: tool,
        stage,
        userId: "user-1",
        chat_id: "chat-1",
        assistant_message_id: "server-message",
        trigger_run_id: "run_server",
      });
      expect(error.name).toBe("FindingHuntToolError");
      expect(error.message).toBe("Finding hunt tool failed");
      expect(error.cause).toBeUndefined();
      const reported = JSON.stringify([message, rest, error.stack]);
      for (const value of sensitive) expect(reported).not.toContain(value);
    },
  );

  it("keeps a saved result successful when its analytics event throws", async () => {
    logEvent.mockImplementation(() => {
      throw rawError();
    });
    start.mockResolvedValue({ success: true, hunt_id: "h1", duplicate: false });
    record.mockResolvedValue(savedCandidate);
    complete.mockResolvedValue(savedHunt);
    const m = await tools();
    expect(
      await m.createStartFindingHunt(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: true, hunt_id: "h1" });
    expect(
      await m.createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      ),
    ).toMatchObject({ success: true, candidate_count: 1 });
    expect(
      await m.createCompleteFindingHunt(context).execute!(completion, options),
    ).toMatchObject({ success: true, counts: savedHunt.counts });
    expect(logError).toHaveBeenCalledTimes(3);
    for (const call of logError.mock.calls)
      expect(call[1]).toMatchObject({ stage: "success_telemetry" });
  });

  it("keeps the safe response when the failure sink also throws", async () => {
    logError.mockImplementation(() => {
      throw new Error("sink down");
    });
    record.mockRejectedValue(rawError());
    const m = await tools();
    expect(
      await m.createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      ),
    ).toMatchObject({ success: false, error: "general" });
  });

  it("rethrows cancellation without reporting a failure", async () => {
    const m = await tools();
    for (const [mock, run] of [
      [
        start,
        (signal: AbortSignal) =>
          m.createStartFindingHunt(context).execute!(
            { finding_id: "finding-1", expected_updated_at: 1 },
            { ...options, abortSignal: signal },
          ),
      ],
      [
        record,
        (signal: AbortSignal) =>
          m.createRecordFindingHuntCandidate(context).execute!(candidate(), {
            ...options,
            abortSignal: signal,
          }),
      ],
      [
        complete,
        (signal: AbortSignal) =>
          m.createCompleteFindingHunt(context).execute!(completion, {
            ...options,
            abortSignal: signal,
          }),
      ],
    ] as const) {
      const controller = new AbortController();
      mock.mockImplementation(async () => {
        controller.abort();
        throw controller.signal.reason;
      });
      const thrown = await Promise.resolve(run(controller.signal)).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(thrown).toBe(controller.signal.reason);
    }
    expect(logError).not.toHaveBeenCalled();
  });

  it("does not report expected refusals as failures", async () => {
    start.mockResolvedValue({
      success: false,
      error: "conflict",
      message: "The report changed.",
    });
    record.mockResolvedValue({
      success: false,
      error: "interrupted",
      message: "Run ended.",
    });
    const m = await tools();
    expect(
      await m.createStartFindingHunt(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ error: "conflict" });
    expect(
      await m.createRecordFindingHuntCandidate(context).execute!(
        candidate(),
        options,
      ),
    ).toMatchObject({ error: "interrupted" });
    expect(logError).not.toHaveBeenCalled();
  });
});
