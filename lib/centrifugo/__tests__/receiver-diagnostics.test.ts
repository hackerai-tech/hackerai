import { createReceiverDiagnostics } from "../receiver-diagnostics";

describe("receiver diagnostics", () => {
  afterEach(() => jest.restoreAllMocks());

  it("bounds a retry storm but preserves its final failure state without content", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {});
    const state = {
      sequence: 7,
      terminalReceived: true,
      cancelRequested: false,
      dispatched: true,
      output: "PRIVATE_OUTPUT",
      command: "PRIVATE_COMMAND",
    };
    const diagnostics = createReceiverDiagnostics(
      { enabled: true, commandId: "command-id", triggerRunId: "run-id" },
      () => state,
    );
    diagnostics.start();
    diagnostics.subscribed(false);
    diagnostics.terminal("exit");
    for (let i = 0; i < 1000; i++) {
      diagnostics.cursorAttempt(false);
      diagnostics.cursorResult(false, 7, false, true);
    }
    diagnostics.finish("deadline");
    diagnostics.finish("canceled");
    expect(log).toHaveBeenCalledTimes(13);
    const records = log.mock.calls.map(([value]) => JSON.parse(value));
    expect(records.at(-1)).toMatchObject({
      phase: "cleanup",
      reason: "deadline",
      ack_attempts: 1000,
      cursor_publish_failures: 1000,
      last_cursor_publish_error: "timeout",
      last_received_sequence: 7,
      last_published_sequence: -1,
      terminal_received: true,
      terminal_type: "exit",
      suppressed_transitions: 991,
    });
    expect(JSON.stringify(records)).not.toMatch(
      /PRIVATE_OUTPUT|PRIVATE_COMMAND/,
    );
  });

  it("does not emit for legacy transports and tolerates a failing log sink", () => {
    const log = jest.spyOn(console, "info").mockImplementation(() => {
      throw new Error("sink down");
    });
    const state = () => ({
      sequence: -1,
      terminalReceived: false,
      cancelRequested: false,
      dispatched: false,
    });
    const disabled = createReceiverDiagnostics(
      { enabled: false, commandId: "id" },
      state,
    );
    disabled.start();
    disabled.finish("deadline");
    expect(log).not.toHaveBeenCalled();
    const enabled = createReceiverDiagnostics(
      { enabled: true, commandId: "id" },
      state,
    );
    expect(() => {
      enabled.start();
      enabled.finish("deadline");
    }).not.toThrow();
  });
});
