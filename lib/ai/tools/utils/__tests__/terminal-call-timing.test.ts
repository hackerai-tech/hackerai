jest.mock("@/lib/analytics/diagnostic-sampling", () => ({
  sampleDiagnosticOperation: jest.fn(() => true),
}));
import { sampleDiagnosticOperation } from "@/lib/analytics/diagnostic-sampling";
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { info: jest.fn() },
}));

import { phLogger } from "@/lib/posthog/server";
import { withTerminalCallTiming } from "../terminal-call-timing";

const context = {
  userID: "user-fixture",
  chatId: "chat-fixture",
  triggerRunId: "run-fixture",
};
const options = { toolCallId: "call-fixture", messages: [] };

afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

test("times one invocation and retains the complete resumable result without logging content", async () => {
  jest
    .spyOn(performance, "now")
    .mockReturnValueOnce(100)
    .mockReturnValueOnce(1234);
  const output = {
    result: {
      output: "private command output",
      error: "private target error",
      recordPath: "/private/record.json",
      session: "opaque-session",
      exitCode: null,
      waitExpired: true,
    },
  };
  const execute = jest.fn(
    async (_input: { timeout: number; command: string }) => output,
  );
  const wrapped = withTerminalCallTiming(context, "run_terminal_cmd", execute);
  const input = { timeout: 30, command: "private command" };
  const result = await wrapped(input, options);

  expect(execute).toHaveBeenCalledTimes(1);
  expect(execute).toHaveBeenCalledWith(input, options);
  expect(result.result).toMatchObject(output.result);
  expect(result.result.callTiming).toMatchObject({ elapsedMs: 1134 });
  expect(output.result).not.toHaveProperty("callTiming");
  expect(phLogger.info).toHaveBeenCalledWith(
    "terminal_call_finished",
    expect.objectContaining({
      tool_elapsed_ms: 1134,
      requested_wait_seconds: 30,
      wait_expired: true,
      session_returned: true,
      exit_code: null,
      outcome: "returned",
    }),
  );
  const logged = JSON.stringify((phLogger.info as jest.Mock).mock.calls);
  expect(logged).not.toContain("private");
  expect(logged).not.toContain("opaque-session");
});

test("preserves cancellation results and caller signal without starting recovery", async () => {
  const controller = new AbortController();
  const execute = jest.fn(async () => {
    controller.abort();
    return { result: { exitCode: 130, output: "partial evidence" } };
  });
  const result = await withTerminalCallTiming(
    context,
    "run_terminal_cmd",
    execute,
  )({}, { ...options, abortSignal: controller.signal });
  expect(result.result).toMatchObject({
    exitCode: 130,
    output: "partial evidence",
  });
  expect(execute).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "terminal_call_finished",
    expect.objectContaining({ signal_aborted: true, exit_code: 130 }),
  );
});

test("retains the original thrown error and keeps its text out of diagnostics", async () => {
  const error = new Error("private credential in provider error");
  const execute = jest.fn(async () => {
    throw error;
  });
  await expect(
    withTerminalCallTiming(
      context,
      "interact_terminal_session",
      execute,
    )({ action: "wait" }, options),
  ).rejects.toBe(error);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "terminal_call_finished",
    expect.objectContaining({ outcome: "threw" }),
  );
  expect(JSON.stringify((phLogger.info as jest.Mock).mock.calls)).not.toContain(
    "private",
  );
});

test("a diagnostic failure does not change completed output or timing", async () => {
  (phLogger.info as jest.Mock).mockImplementationOnce(() => {
    throw new Error("logger unavailable");
  });
  const output = { result: { exitCode: 0, output: "verified marker" } };
  const result = await withTerminalCallTiming(
    context,
    "run_terminal_cmd",
    async () => output,
  )({}, options);
  expect(result.result).toMatchObject(output.result);
  expect(result.result.callTiming).toEqual(
    expect.objectContaining({ elapsedMs: expect.any(Number) }),
  );
});

describe("routine terminal log sampling", () => {
  beforeEach(() =>
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false),
  );

  test("suppresses routine log ingestion while preserving result, timing and execution count", async () => {
    const output = { result: { exitCode: 0, output: "PRIVATE" } };
    const execute = jest.fn(async () => output);
    const actual = await withTerminalCallTiming(
      context,
      "run_terminal_cmd",
      execute,
    )({}, options);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(actual.result).toMatchObject(output.result);
    expect(actual.result.callTiming.elapsedMs).toEqual(expect.any(Number));
    expect(phLogger.info).not.toHaveBeenCalled();
  });

  test("tags sampled routine calls for weighted log analysis", async () => {
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
    await withTerminalCallTiming(
      context,
      "interact_terminal_session",
      async () => ({ result: { session: "PRIVATE" } }),
    )({ action: "view" }, options);
    expect(phLogger.info).toHaveBeenCalledWith(
      "terminal_call_finished",
      expect.objectContaining({
        telemetry_sample_rate: 0.1,
        telemetry_selection: "sampled",
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
      "PRIVATE",
    );
  });

  test.each([
    { error: "PRIVATE", exitCode: 0 },
    { exitCode: 2 },
    { exited: { exitCode: 130 }, session: "PRIVATE" },
    { exited: { exitCode: null }, session: "PRIVATE" },
    { waitExpired: true, session: "PRIVATE" },
    { timedOut: true, exitCode: 0 },
    { recovered: true, exitCode: 0 },
    { recordPersistenceFailed: true, exitCode: 0 },
    { recordPersistenceStatus: "pending", exitCode: 0 },
    { status: "unknown", session: "PRIVATE" },
    { success: false, exitCode: 0 },
    {},
  ])(
    "keeps structured failures, recovery and unknown results: %p",
    async (result) => {
      await withTerminalCallTiming(context, "run_terminal_cmd", async () => ({
        result,
      }))({}, options);
      expect(phLogger.info).toHaveBeenCalledWith(
        "terminal_call_finished",
        expect.objectContaining({
          telemetry_sample_rate: 1,
          telemetry_selection: "diagnostic",
        }),
      );
      expect(
        JSON.stringify(jest.mocked(phLogger.info).mock.calls),
      ).not.toContain("PRIVATE");
    },
  );

  test("keeps slow successful calls even outside the sampled cohort", async () => {
    jest
      .spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(30_000);
    await withTerminalCallTiming(context, "run_terminal_cmd", async () => ({
      result: { exitCode: 0 },
    }))({}, options);
    expect(phLogger.info).toHaveBeenCalledWith(
      "terminal_call_finished",
      expect.objectContaining({
        telemetry_sample_rate: 1,
        tool_elapsed_ms: 30_000,
      }),
    );
  });
});

test("correlates returned terminal sessions across command and interaction timing", async () => {
  jest.mocked(sampleDiagnosticOperation).mockReturnValue(true);
  const executeCommand = jest.fn(async () => ({
    result: {
      session: "a1b2c3d4",
      exitCode: 0,
      recordPersistenceFailed: true,
    },
  }));
  const executeInteraction = jest.fn(
    async (_input: { action: "wait"; session: string }) => ({
      result: {
        session: "a1b2c3d4",
        exitCode: 0,
      },
    }),
  );
  const command = await withTerminalCallTiming(
    context,
    "run_terminal_cmd",
    executeCommand,
  )({}, options);
  const interaction = await withTerminalCallTiming(
    context,
    "interact_terminal_session",
    executeInteraction,
  )(
    { action: "wait", session: "private requested value" },
    { ...options, toolCallId: "next-call" },
  );
  expect(executeCommand).toHaveBeenCalledTimes(1);
  expect(executeInteraction).toHaveBeenCalledTimes(1);
  expect(command.result.recordPersistenceFailed).toBe(true);
  expect(interaction.result.session).toBe("a1b2c3d4");
  const logs = jest
    .mocked(phLogger.info)
    .mock.calls.map(([, fields]) => fields);
  expect(logs).toEqual([
    expect.objectContaining({
      trigger_run_id: "run-fixture",
      tool_call_id: "call-fixture",
      terminal_session_id: "a1b2c3d4",
      record_persistence_failed: true,
      telemetry_version: 3,
    }),
    expect.objectContaining({
      trigger_run_id: "run-fixture",
      tool_call_id: "next-call",
      terminal_session_id: "a1b2c3d4",
      record_persistence_failed: false,
      telemetry_version: 3,
    }),
  ]);
  expect(JSON.stringify(logs)).not.toContain("private requested value");
});

test.each([
  undefined,
  null,
  123,
  "private session",
  "deadbeef\n",
  "ABCDEF01",
  "a1b2c3d45",
  "abcdefg1",
])(
  "omits noncanonical returned session values from timing diagnostics: %p",
  async (session) => {
    await withTerminalCallTiming(
      context,
      "interact_terminal_session",
      async (_input: { action: "view"; session: string }) => ({
        result: { session, exitCode: 2 },
      }),
    )({ action: "view", session: "a1b2c3d4" }, options);
    expect(phLogger.info).toHaveBeenCalledWith(
      "terminal_call_finished",
      expect.objectContaining({
        terminal_session_id: null,
        telemetry_version: 3,
      }),
    );
    const logged = JSON.stringify(jest.mocked(phLogger.info).mock.calls);
    expect(logged).not.toContain("a1b2c3d4");
    expect(logged).not.toContain("private session");
  },
);

// Pending saves must remain diagnosable without claiming lost evidence.
test.each(["run_terminal_cmd", "interact_terminal_session"] as const)(
  "%s logs pending checkpoint state separately from failure",
  async (toolName) => {
    await withTerminalCallTiming(context, toolName, async () => ({
      result: { exitCode: 0, recordPersistenceStatus: "pending" },
    }))({}, options);
    expect(phLogger.info).toHaveBeenCalledWith(
      "terminal_call_finished",
      expect.objectContaining({
        record_persistence_status: "pending",
        record_persistence_failed: false,
        telemetry_selection: "diagnostic",
      }),
    );
  },
);

test("retains OPEN result context even when a compound shell exits successfully", async () => {
  jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
  const output = {
    result: {
      processStarted: true,
      exitCode: 0,
      output:
        'Navigation failed: PRIVATE_TARGET\n{"success":false,"error":"Daemon failed to start: PRIVATE_PATH"}',
    },
  };
  const execute = jest.fn(
    async (_input: { command: string; is_background: boolean }) => output,
  );
  const input = {
    command: "agent-browser open https://PRIVATE_TARGET; echo PRIVATE_TEXT",
    is_background: false,
  };
  const actual = await withTerminalCallTiming(
    context,
    "run_terminal_cmd",
    execute,
  )(input, options);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(actual.result).toMatchObject(output.result);
  expect(phLogger.info).toHaveBeenCalledTimes(1);
  expect(phLogger.info).toHaveBeenCalledWith(
    "terminal_call_finished",
    expect.objectContaining({
      telemetry_sample_rate: 1,
      browser_result_context_version: 1,
      browser_intent: "open",
      browser_detected_invocation_count: 1,
      browser_failure_capture_eligibility: "zero_exit",
      browser_process_started: "true",
      browser_execution_outcome: "absent",
      browser_public_output_hint: "multiple_markers",
      browser_public_json_error_state: "observed",
    }),
  );
  expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
    "PRIVATE",
  );
});

test.each([
  {
    result: { exitCode: 1 },
    interactive: false,
    is_background: false,
    expected: "process_start_unavailable",
  },
  {
    result: { processStarted: false, exitCode: 1 },
    interactive: false,
    is_background: false,
    expected: "process_not_started",
  },
  {
    result: { processStarted: true, exitCode: 1, executionOutcome: "unknown" },
    interactive: false,
    is_background: false,
    expected: "outcome_unknown",
  },
  {
    result: { processStarted: true, exitCode: 1 },
    interactive: true,
    is_background: false,
    expected: "interactive",
  },
  {
    result: { processStarted: true, exitCode: 1 },
    interactive: false,
    is_background: true,
    expected: "background",
  },
  {
    result: { processStarted: true, exitCode: 1, approvalDenied: true },
    interactive: false,
    is_background: false,
    expected: "approval_denied",
  },
])(
  "records actual option-intent gates without claiming a failed OPEN: $expected",
  async ({ result, interactive, is_background, expected }) => {
    await withTerminalCallTiming(
      context,
      "run_terminal_cmd",
      async (_input: {
        command: string;
        interactive: boolean;
        is_background: boolean;
      }) => ({ result }),
    )(
      {
        command: "agent-browser --session PRIVATE_SESSION open PRIVATE_TARGET",
        interactive,
        is_background,
      },
      options,
    );
    expect(phLogger.info).toHaveBeenCalledWith(
      "terminal_call_finished",
      expect.objectContaining({
        browser_intent: "option",
        browser_failure_capture_eligibility: expected,
        browser_interactive: interactive,
        browser_background: is_background,
        browser_approval_denied: "approvalDenied" in result,
      }),
    );
    expect(JSON.stringify(jest.mocked(phLogger.info).mock.calls)).not.toContain(
      "PRIVATE",
    );
  },
);

test.each([
  { tool: "run_terminal_cmd", input: { command: "agent-browser snapshot -i" } },
  {
    tool: "run_terminal_cmd",
    input: { command: "echo 'agent-browser open PRIVATE'" },
  },
  {
    tool: "interact_terminal_session",
    input: { action: "send", command: "agent-browser open PRIVATE" },
  },
] as const)(
  "preserves routine sampling outside recognized OPEN command calls: $tool $input",
  async ({ tool, input }) => {
    jest.mocked(sampleDiagnosticOperation).mockReturnValue(false);
    const output = {
      result: { exitCode: 0, processStarted: true, output: "PRIVATE" },
    };
    const actual = await withTerminalCallTiming(
      context,
      tool,
      async (_input: typeof input) => output,
    )(input, options);
    expect(actual.result).toMatchObject(output.result);
    expect(phLogger.info).not.toHaveBeenCalled();
  },
);
