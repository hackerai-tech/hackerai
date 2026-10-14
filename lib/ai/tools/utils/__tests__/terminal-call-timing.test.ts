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
