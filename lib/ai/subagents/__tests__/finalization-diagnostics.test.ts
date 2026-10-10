import { createSubagentFinalizationDiagnostics } from "../finalization-diagnostics";

const context = {
  subagent_id: "child-1",
  parent_trigger_run_id: "parent-1",
  trigger_run_id: "run-1",
  environment: "PREVIEW",
};

it.each(["updated", "pending_messages", "stale"] as const)(
  "preserves the authoritative %s outcome without emitting an error",
  async (outcome) => {
    const emit = jest.fn();
    const mutation = jest.fn(async () => outcome);
    const observe = createSubagentFinalizationDiagnostics(context, emit);
    await expect(observe("result_submission", false, mutation)).resolves.toBe(
      outcome,
    );
    expect(mutation).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  },
);

it("distinguishes submission from post-stream failure without retrying an ambiguous write", async () => {
  const emit = jest.fn();
  const observe = createSubagentFinalizationDiagnostics(context, emit);
  const error = new TypeError("fetch failed", {
    cause: Object.assign(new Error("private endpoint and credentials"), {
      code: "ECONNRESET",
    }),
  });
  const mutation = jest.fn(async () => {
    throw error;
  });
  await expect(observe("result_submission", false, mutation)).rejects.toBe(
    error,
  );
  await expect(observe("stream_completion", true, mutation)).rejects.toBe(
    error,
  );
  expect(mutation).toHaveBeenCalledTimes(2);
  expect(
    emit.mock.calls.map(([fields]) => [
      fields.finalization_operation,
      fields.result_accepted,
      fields.error_code,
    ]),
  ).toEqual([
    ["result_submission", false, "ECONNRESET"],
    ["stream_completion", true, "ECONNRESET"],
  ]);
  expect(JSON.stringify(emit.mock.calls)).not.toMatch(
    /private endpoint|credentials|fetch failed/,
  );
});

it("shares the diagnostic budget across boundaries and concurrent attempts in a run", async () => {
  const emit = jest.fn();
  const observe = createSubagentFinalizationDiagnostics(context, emit);
  const error = new Error("private result");
  const mutation = jest.fn(async () => {
    throw error;
  });
  const outcomes = await Promise.allSettled(
    Array.from({ length: 8 }, (_, index) =>
      observe(
        index % 2 ? "stream_completion" : "result_submission",
        false,
        mutation,
      ),
    ),
  );
  expect(outcomes).toEqual(
    Array.from({ length: 8 }, () => ({ status: "rejected", reason: error })),
  );
  expect(mutation).toHaveBeenCalledTimes(8);
  expect(emit).toHaveBeenCalledTimes(2);
  const anotherRun = createSubagentFinalizationDiagnostics(
    { ...context, trigger_run_id: "run-2" },
    emit,
  );
  await expect(anotherRun("result_submission", false, mutation)).rejects.toBe(
    error,
  );
  expect(emit).toHaveBeenCalledTimes(3);
});

it("preserves cancellation and the original error even if diagnostics throw", async () => {
  const emit = jest.fn(() => {
    throw new Error("logger failed");
  });
  const observe = createSubagentFinalizationDiagnostics(context, emit);
  const aborted = new DOMException("private cancellation reason", "AbortError");
  await expect(
    observe("stream_completion", true, () => {
      throw aborted;
    }),
  ).rejects.toBe(aborted);
  expect(emit).toHaveBeenCalledTimes(1);
});

it("excludes arbitrary error names, codes, response bodies and result content", async () => {
  const emit = jest.fn();
  const observe = createSubagentFinalizationDiagnostics(context, emit);
  const error = Object.assign(new Error("private result and prompt"), {
    name: "private-name",
    code: "private-code",
    responseBody: "private-body",
    statusCode: 503,
  });
  await expect(
    observe("result_submission", false, async () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(emit).toHaveBeenCalledWith(
    expect.objectContaining({ status_code: 503 }),
  );
  expect(JSON.stringify(emit.mock.calls)).not.toContain("private");
});
