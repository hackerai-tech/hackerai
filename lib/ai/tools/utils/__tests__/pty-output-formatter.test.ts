import {
  cleanPtyForUI,
  createPtyParserLogBudget,
  type PtyParserLogContext,
} from "../pty-output-formatter";

const LOG_CONTEXT: PtyParserLogContext = {
  service: "agent-long",
  environment: "test",
  request_id: "run_test",
  trigger_run_id: "run_test",
  chat_id: "chat_test",
  user_id: "user_test",
  session_id: "session_test",
};

describe("cleanPtyForUI", () => {
  it("keeps normal terminal output without emitting diagnostics", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();

    await expect(cleanPtyForUI("hello\r\nworld", LOG_CONTEXT)).resolves.toBe(
      "hello\nworld",
    );
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });

  it("aggregates and caps repeated parser diagnostics without logging PTY content", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const raw = `private-prefix${"\x7f".repeat(10_005)}private-suffix`;

    await expect(cleanPtyForUI(raw, LOG_CONTEXT)).resolves.toBe(
      "private-prefixprivate-suffix",
    );

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(warnSpy.mock.calls[0]?.[0] as string) as Record<
      string,
      unknown
    >;
    expect(payload).toMatchObject({
      level: "warn",
      event: "pty_xterm_diagnostics_aggregated",
      service: "agent-long",
      environment: "test",
      request_id: "run_test",
      trigger_run_id: "run_test",
      chat_id: "chat_test",
      user_id: "user_test",
      session_id: "session_test",
      reason: "xterm_parser_error",
      parser_error_count: 10_000,
      other_error_count: 0,
      diagnostic_count_capped: true,
      diagnostic_log_scope: "task_run",
      diagnostic_log_limit: null,
      input_bytes: Buffer.byteLength(raw, "utf8"),
      cleaned_output_chars: "private-prefixprivate-suffix".length,
    });
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("private-prefix");
    expect(warnSpy.mock.calls[0]?.[0]).not.toContain("private-suffix");

    warnSpy.mockRestore();
  });

  it("shares one diagnostic log budget across a durable task run", async () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation();
    const context = {
      ...LOG_CONTEXT,
      log_budget: createPtyParserLogBudget(),
    };

    await cleanPtyForUI("\x7f", context);
    await cleanPtyForUI("\x7f\x7f", context);

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(JSON.parse(warnSpy.mock.calls[0]?.[0] as string)).toMatchObject({
      diagnostic_log_scope: "task_run",
      diagnostic_log_limit: 1,
      parser_error_count: 1,
    });
    expect(context.log_budget.remaining_logs).toBe(0);

    warnSpy.mockRestore();
  });
});
