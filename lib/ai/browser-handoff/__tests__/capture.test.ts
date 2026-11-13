import {
  BrowserPreviewUnavailable,
  browserSessionReadFailureContext,
  browserRelayRenewFailureContext,
  captureBrowserFrame,
  getActiveBrowserSessionName,
  getPrivateStreamPort,
  renewBrowserRelay,
  resizeBrowserViewport,
} from "../server";
import { CommandExitError, TimeoutError } from "@e2b/code-interpreter";
import type { Sandbox } from "@e2b/code-interpreter";
import { RELAY_RENEW_FAILURE_CODES } from "../relay-program";

jest.mock("server-only", () => ({}));
jest.mock("@e2b/code-interpreter", () => ({
  Sandbox: {},
  CommandExitError: class extends Error {
    constructor(
      readonly result: { exitCode: number; stdout: string; stderr: string },
    ) {
      super("PRIVATE SDK error");
    }
  },
  TimeoutError: class extends Error {},
}));
jest.mock("@/lib/ai/tools/utils/e2b-cluster", () => ({
  getE2BClusterRouting: jest.fn(),
}));
jest.mock("@/lib/ai/tools/utils/sandbox-command-options", () => ({
  buildSandboxCommandOptions: () => ({ user: "root" }),
}));

const location = {
  userId: "owner",
  sandboxId: "sandbox",
  triggerRegion: null,
  directory: "/dev/shm/hackerai-browser-0123456789abcdef01234567",
  expiresAt: Number.MAX_SAFE_INTEGER,
};
const cached = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const fresh = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]);

it.each([false, true])(
  "retains combined failure context within the unchanged parser cap (oversized:%s)",
  async (oversized) => {
    const packet = JSON.stringify({
      diagnostic_reason: "sockets_stat",
      diagnostic_error: "not_directory",
      wrapper_receipt_version: 1,
      wrapper_action: "version",
      wrapper_phase: "completed",
      wrapper_exit: "other",
      wrapper_session_matches: false,
      wrapper_age: "unknown",
      open_receipt_version: 1,
      open_receipt_status: "recorded",
      open_phase: "completed",
      open_exit: 0,
      open_session_matches: true,
      open_age: "unknown",
      h1: 3,
      close_receipt: [
        1,
        "recorded",
        "completed",
        "other",
        "selected_session",
        "unknown",
        "same_time",
      ],
      open_idle: [1, "unparsed"],
      p1: [1, 2, 0],
      cv: [1, 1, 999999999],
    });
    expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(544);
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: oversized ? packet + " ".repeat(545 - packet.length) : packet,
    });
    sandbox.commands.run.mockRejectedValue(error);
    const observe = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ),
    ).rejects.toBe(error);
    const context = observe.mock.calls[0][0];
    if (oversized) {
      expect(context).not.toHaveProperty("capture_cli_at_prepare_status");
      expect(context).not.toHaveProperty("capture_precondition_reason");
    } else
      expect(context).toMatchObject({
        capture_cli_at_prepare_status: "measured",
        capture_cli_at_prepare_major: 999,
        capture_cli_at_prepare_minor: 999,
        capture_cli_at_prepare_patch: 999,
        capture_precondition_reason: "sockets_stat",
        capture_precondition_error: "not_directory",
        capture_wrapper_session_matches: false,
        capture_wrapper_other_cli_completed: true,
        capture_wrapper_option_prefix_completed: true,
        capture_open_idle_env: "unparsed",
        capture_close_scope: "selected_session",
        capture_close_open_order: "same_time",
        capture_daemon_pid_status: "unreadable",
      });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  [[1, 0], "unavailable", undefined],
  [[1, 1, 999999999], "measured", [999, 999, 999]],
  [[1, 1, 39003], "measured", [0, 39, 3]],
  [[1, 2], "not_checked", undefined],
  [[1, 3], "unparsed", undefined],
  [[1, 4], "check_failed", undefined],
  [[1, 1, -1], undefined, undefined],
  [[1, 1, 1000000000], undefined, undefined],
  [[1, 2, "PRIVATE"], undefined, undefined],
  [[2, 1, 39003], undefined, undefined],
  [[1, 1, 39.3], undefined, undefined],
])(
  "projects only strict CLI-at-prepare tuples (%#)",
  async (cv, status, semver) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        cv,
        private: "PRIVATE",
      }),
    });
    sandbox.commands.run.mockRejectedValue(error);
    const observe = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ),
    ).rejects.toBe(error);
    const context = observe.mock.calls[0][0];
    expect(context.capture_cli_at_prepare_diagnostic_version).toBe(
      status ? 1 : undefined,
    );
    expect(context.capture_cli_at_prepare_status).toBe(status);
    expect([
      context.capture_cli_at_prepare_major,
      context.capture_cli_at_prepare_minor,
      context.capture_cli_at_prepare_patch,
    ]).toEqual(semver ?? [undefined, undefined, undefined]);
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([true, false])(
  "adds only the controlled bridge-failure tuple while preserving rejection (SDK throws: %s)",
  async (throws) => {
    const sandbox = fixture();
    const result = {
      exitCode: 6,
      stdout: JSON.stringify({
        bridge_failure: [1, "early_close", "awaiting_frame", 1006],
        private: "PRIVATE",
      }),
      stderr: "PRIVATE",
    };
    const original = new CommandExitError(result);
    if (throws) sandbox.commands.run.mockRejectedValue(original);
    else sandbox.commands.run.mockResolvedValue(result);
    const observe = jest.fn();
    const capture = captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observe,
    );
    if (throws) await expect(capture).rejects.toBe(original);
    else await expect(capture).rejects.toThrow();
    expect(observe.mock.calls[0][0]).toMatchObject({
      capture_stage: "frame_bridge",
      capture_bridge_diagnostic_version: 1,
      capture_bridge_failure: "early_close",
      capture_bridge_phase: "awaiting_frame",
      capture_bridge_close_code: 1006,
    });
    expect(JSON.stringify(observe.mock.calls[0][0])).not.toContain("PRIVATE");
  },
);

it.each([
  [undefined, false],
  [1, true],
  [0, true],
  [3, true],
  [4, false],
  [2, false],
  ["PRIVATE", false],
  [true, false],
  [[1, 1, "PRIVATE"], false],
])(
  "projects only bounded root-scoped wrapper completion history (%#)",
  async (history, valid) => {
    const sandbox = fixture();
    sandbox.commands.run.mockRejectedValue(
      new CommandExitError({
        exitCode: 2,
        stderr: "PRIVATE",
        stdout: JSON.stringify({
          diagnostic_reason: "socket_stat",
          h1: history,
        }),
      }),
    );
    const observe = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ),
    ).rejects.toThrow();
    const context = observe.mock.calls[0][0];
    if (valid)
      expect(context).toMatchObject({
        capture_wrapper_history_version: 1,
        capture_wrapper_history_scope: "handoff_root",
        capture_wrapper_other_cli_completed: ((history as number) & 1) !== 0,
        capture_wrapper_option_prefix_completed:
          ((history as number) & 2) !== 0,
      });
    else expect(context).not.toHaveProperty("capture_wrapper_history_version");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  [[1, "15m"], true, "15m"],
  [[1, "unset"], true, "unset"],
  [[1, "PRIVATE_ENV"], true, undefined],
  [[2, "15m"], true, undefined],
  [[1, "15m", "PRIVATE"], true, undefined],
  [[1, "15m"], false, undefined],
  [undefined, true, undefined],
])(
  "projects only a matching versioned open idle declaration (%#)",
  async (tuple, matches, expected) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        open_receipt_version: 1,
        open_receipt_status: "recorded",
        open_phase: "completed",
        open_exit: 0,
        open_session_matches: matches,
        open_age: "lt5m",
        open_idle: tuple,
      }),
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    const context = observed.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_precondition_reason: "socket_stat",
      capture_precondition_error: "missing",
    });
    if (expected)
      expect(context).toMatchObject({
        capture_open_idle_env_version: 1,
        capture_open_idle_env: expected,
      });
    else expect(context).not.toHaveProperty("capture_open_idle_env");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  [
    new DOMException("PRIVATE native timer", "TimeoutError"),
    {
      active_session_read_error_kind: "dom_timeout",
      active_session_read_http_status: "none",
    },
  ],
  [
    new DOMException("PRIVATE native cancellation", "AbortError"),
    {
      active_session_read_error_kind: "dom_abort",
      active_session_read_http_status: "none",
    },
  ],
  [
    Object.assign(new Error("PRIVATE missing path"), {
      name: "FileNotFoundError",
      statusCode: 404,
    }),
    {
      active_session_read_error_kind: "file_not_found",
      active_session_read_http_status: 404,
    },
  ],
  [
    Object.assign(new Error("PRIVATE SDK request"), { name: "TimeoutError" }),
    {
      active_session_read_error_kind: "timeout",
      active_session_read_http_status: "none",
    },
  ],
  [
    new TypeError("fetch failed", {
      cause: { code: "ECONNRESET", url: "PRIVATE" },
    }),
    {
      active_session_read_error_kind: "other_error",
      active_session_read_http_status: "none",
      active_session_read_type_error_signal: "fetch_failed",
      active_session_read_transport_code: "ECONNRESET",
    },
  ],
])(
  "retains bounded active-session read attribution while preserving loading (%#)",
  async (error, fields) => {
    const read = jest.fn().mockRejectedValue(error);
    const sandbox = { files: { read } } as unknown as Sandbox;
    let failure: unknown;
    try {
      await getActiveBrowserSessionName(sandbox, location);
    } catch (caught) {
      failure = caught;
    }
    expect(failure).toMatchObject({ state: "loading" });
    expect(browserSessionReadFailureContext(failure)).toEqual({
      active_session_read_diagnostic_version: 1,
      ...fields,
    });
    expect(
      JSON.stringify(browserSessionReadFailureContext(failure)),
    ).not.toContain("PRIVATE");
    expect(JSON.stringify(failure)).toBe('{"state":"loading"}');
    expect(read).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledWith(`${location.directory}/active-session`, {
      user: "root",
      requestTimeoutMs: 8_000,
    });
  },
);

it("keeps successful and invalid session-name reads free of SDK failure diagnostics", async () => {
  const read = jest
    .fn()
    .mockResolvedValueOnce("default\n")
    .mockResolvedValueOnce("PRIVATE/invalid");
  const sandbox = { files: { read } } as unknown as Sandbox;
  await expect(getActiveBrowserSessionName(sandbox, location)).resolves.toBe(
    "default",
  );
  let failure: unknown;
  try {
    await getActiveBrowserSessionName(sandbox, location);
  } catch (caught) {
    failure = caught;
  }
  expect(failure).toMatchObject({ state: "closed" });
  expect(browserSessionReadFailureContext(failure)).toBeUndefined();
  expect(
    browserSessionReadFailureContext(new Error("PRIVATE")),
  ).toBeUndefined();
});

it.each([2, 3])(
  "carries only validated wrapper context from the failed status helper (%s)",
  async (exitCode) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        wrapper_receipt_version: 1,
        wrapper_action: "close",
        wrapper_phase: "completed",
        wrapper_exit: 37,
        wrapper_session_matches: false,
        wrapper_age: "lt60s",
        open_receipt_version: 1,
        open_receipt_status: "recorded",
        open_phase: "completed",
        open_exit: 0,
        open_session_matches: true,
        open_age: "older",
        session: "PRIVATE_NAME",
        command: "PRIVATE_COMMAND",
      }),
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: "stream_status",
      capture_error_kind: "command_exit",
      capture_command_exit_code: exitCode,
      capture_wrapper_receipt_version: 1,
      capture_wrapper_action: "close",
      capture_wrapper_phase: "completed",
      capture_wrapper_exit_code: 37,
      capture_wrapper_session_matches: false,
      capture_wrapper_age: "lt60s",
      capture_open_receipt_version: 1,
      capture_open_receipt_status: "recorded",
      capture_open_phase: "completed",
      capture_open_exit_code: 0,
      capture_open_session_matches: true,
      capture_open_age: "older",
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it("rejects a partially invalid wrapper receipt without retaining its private fields", async () => {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode: 2,
    stderr: "PRIVATE",
    stdout: JSON.stringify({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      wrapper_receipt_version: 1,
      wrapper_action: "open",
      wrapper_phase: "completed",
      wrapper_exit: 0,
      wrapper_session_matches: "PRIVATE",
      wrapper_age: "lt60s",
    }),
  });
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed).toHaveBeenCalledWith({
    capture_stage: "stream_status",
    capture_error_kind: "command_exit",
    capture_command_exit_code: 2,
    capture_precondition_reason: "socket_stat",
    capture_precondition_error: "missing",
  });
});

it.each([
  [
    JSON.stringify({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      private: "PRIVATE_CANARY",
    }),
    {
      capture_precondition_reason: "socket_stat",
      capture_precondition_error: "missing",
    },
  ],
  [
    JSON.stringify({
      diagnostic_reason: "PRIVATE_CANARY",
      diagnostic_error: "PRIVATE_CANARY",
    }),
    {},
  ],
])(
  "reads only fixed helper preconditions from a stream-status exit2",
  async (stdout, context) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stdout,
      stderr: "PRIVATE",
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: "stream_status",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 2,
      ...context,
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([
  [
    3,
    [1, "connecting"],
    {
      capture_deadline_diagnostic_version: 1,
      capture_deadline_phase: "connecting",
    },
  ],
  [
    3,
    [1, "awaiting_response"],
    {
      capture_deadline_diagnostic_version: 1,
      capture_deadline_phase: "awaiting_response",
    },
  ],
  [
    3,
    [1, "partial_response"],
    {
      capture_deadline_diagnostic_version: 1,
      capture_deadline_phase: "partial_response",
    },
  ],
  [3, [2, "connecting"], {}],
  [3, [1, "PRIVATE"], {}],
  [3, [1, "connecting", "PRIVATE"], {}],
  [2, [1, "connecting"], {}],
])(
  "exports only the controlled deadline tuple for exit %s (%#)",
  async (exitCode, deadline, context) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: exitCode as number,
      stdout: JSON.stringify({ deadline, private: "PRIVATE" }),
      stderr: "PRIVATE",
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: "stream_status",
      capture_error_kind: "command_exit",
      capture_command_exit_code: exitCode,
      ...(context as object),
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([
  ["fresh_screenshot", true],
  ["frame_bridge", false],
])(
  "keeps deadline metadata restricted to the daemon at %s",
  async (stage, eligible) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const error = new CommandExitError({
      exitCode: 3,
      stdout: JSON.stringify({ deadline: [1, "awaiting_response"] }),
      stderr: "PRIVATE",
    });
    sandbox.commands.run.mockImplementation(async (command: string) => {
      if (
        stage === "fresh_screenshot"
          ? command.includes('"action":"screenshot"')
          : !command.includes('"action":"stream_status"')
      )
        throw error;
      return run(command);
    });
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        true,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    const context = observed.mock.calls[0][0];
    expect(context.capture_stage).toBe(stage);
    if (eligible)
      expect(context).toMatchObject({
        capture_deadline_diagnostic_version: 1,
        capture_deadline_phase: "awaiting_response",
      });
    else expect(context).not.toHaveProperty("capture_deadline_phase");
    expect(sandbox.files.remove).toHaveBeenCalledTimes(eligible ? 1 : 0);
  },
);

it.each([
  [0, "stream_status"],
  [1, "frame_bridge"],
])(
  "preserves the SDK error and reports only bounded context at command %s",
  async (failedCommand, stage) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 5,
      stdout: "PRIVATE_FRAME",
      stderr: "PRIVATE_URL",
    });
    if (failedCommand === 1)
      sandbox.commands.run.mockResolvedValueOnce({
        exitCode: 0,
        stdout: JSON.stringify({ data: { port: 1234 } }),
      });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: stage,
      capture_error_kind: "command_exit",
      capture_command_exit_code: 5,
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
    expect(sandbox.commands.run).toHaveBeenCalledTimes(failedCommand + 1);
  },
);

it("contains an observer exception without replacing the capture error or retrying", async () => {
  const sandbox = fixture();
  const error = new Error("PRIVATE capture");
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn(() => {
    throw new Error("PRIVATE observer");
  });
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
});

it("does not invoke exit-code accessors or emit an unbounded number", async () => {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode: -1,
    stdout: "PRIVATE",
    stderr: "PRIVATE",
  });
  const getter = jest.fn(() => {
    throw new Error("PRIVATE accessor");
  });
  Object.defineProperty(error, "exitCode", { get: getter });
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(getter).not.toHaveBeenCalled();
  expect(observed).toHaveBeenCalledWith({
    capture_stage: "stream_status",
    capture_error_kind: "command_exit",
    capture_command_exit_code: "other",
  });
});

it("reports a fresh screenshot failure after the cached frame and retains cleanup", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const error = new CommandExitError({
    exitCode: 6,
    stdout: "PRIVATE",
    stderr: "PRIVATE",
  });
  sandbox.commands.run.mockImplementation(async (command) => {
    if (command.includes('"action":"screenshot"')) throw error;
    return run(command);
  });
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed).toHaveBeenCalledWith({
    capture_stage: "fresh_screenshot",
    capture_error_kind: "command_exit",
    capture_command_exit_code: 6,
  });
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  expect(sandbox.files.read).not.toHaveBeenCalled();
});

it.each([2, 3, 6])(
  "preserves bounded helper context for fresh screenshot exit%s",
  async (exitCode) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const error = new CommandExitError({
      exitCode,
      stdout: JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        wrapper_receipt_version: 1,
        wrapper_action: "open",
        wrapper_phase: "started",
        wrapper_exit: "none",
        wrapper_session_matches: true,
        wrapper_age: "lt10s",
        private: "PRIVATE_CAPTURE_PATH",
      }),
      stderr: "PRIVATE_CAPTURE_OUTPUT",
    });
    sandbox.commands.run.mockImplementation(async (command) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    });
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        true,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: "fresh_screenshot",
      capture_error_kind: "command_exit",
      capture_command_exit_code: exitCode,
      ...(exitCode === 2
        ? {
            capture_precondition_reason: "socket_stat",
            capture_precondition_error: "missing",
          }
        : {}),
      capture_wrapper_receipt_version: 1,
      capture_wrapper_action: "open",
      capture_wrapper_phase: "started",
      capture_wrapper_exit_code: "none",
      capture_wrapper_session_matches: true,
      capture_wrapper_age: "lt10s",
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
    expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
    expect(sandbox.files.read).not.toHaveBeenCalled();
  },
);

it.each([
  [1, '{"diagnostic_reason":"socket_stat","diagnostic_error":"missing"}'],
  [7, '{"diagnostic_reason":"socket_stat","diagnostic_error":"missing"}'],
  [
    2,
    JSON.stringify({
      diagnostic_reason: "socket_stat",
      diagnostic_error: "missing",
      private: "PRIVATE".repeat(100),
    }),
  ],
  [2, "PRIVATE_MALFORMED_JSON"],
])(
  "excludes unrelated or unbounded fresh helper output (exit%s)",
  async (exitCode, stdout) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const error = new CommandExitError({ exitCode, stdout, stderr: "PRIVATE" });
    sandbox.commands.run.mockImplementation(async (command) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    });
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        true,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: "fresh_screenshot",
      capture_error_kind: "command_exit",
      capture_command_exit_code: exitCode,
    });
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  },
);

it("does not invoke a fresh helper output accessor or inspect bridge output", async () => {
  const getter = jest.fn(() => {
    throw new Error("PRIVATE_ACCESSOR");
  });
  for (const freshStage of [false, true]) {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const stdoutDescriptors = jest.fn();
    const result = new Proxy(
      Object.defineProperty({ exitCode: 2, stderr: "PRIVATE" }, "stdout", {
        get: getter,
      }),
      {
        getOwnPropertyDescriptor(target, key) {
          if (key === "stdout") stdoutDescriptors();
          return Reflect.getOwnPropertyDescriptor(target, key);
        },
      },
    );
    const error = new CommandExitError(result as any);
    sandbox.commands.run.mockImplementation(async (command) => {
      if (
        freshStage
          ? command.includes('"action":"screenshot"')
          : !command.includes('"action":"stream_status"')
      )
        throw error;
      return run(command);
    });
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        true,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed).toHaveBeenCalledWith({
      capture_stage: freshStage ? "fresh_screenshot" : "frame_bridge",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 2,
    });
    expect(stdoutDescriptors).toHaveBeenCalledTimes(freshStage ? 1 : 0);
  }
  expect(getter).not.toHaveBeenCalled();
});

function fixture(screenshotExitCode = 0, viewportExitCode = 0) {
  const sandbox = {
    commands: {
      run: jest.fn(async (command: string) => {
        if (command.includes('"action":"stream_status"'))
          return {
            exitCode: 0,
            stdout: JSON.stringify({ data: { port: 1234 } }),
          };
        if (command.includes('"action":"screenshot"'))
          return { exitCode: screenshotExitCode, stdout: "" };
        if (command.includes('"action":"viewport"'))
          return { exitCode: viewportExitCode, stdout: "" };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: cached.toString("base64"),
            width: 800,
            height: 600,
            capturedAt: 0,
          }),
        };
      }),
    },
    files: {
      getInfo: jest.fn(async () => ({ size: fresh.length })),
      read: jest.fn(async () => fresh),
      remove: jest.fn(async () => undefined),
    },
  };
  return sandbox;
}

it("replaces an undated cached preview with a newly captured image for handoff", async () => {
  const sandbox = fixture();
  const before = Date.now();
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
  );
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
  expect(result.capturedAt).toBeGreaterThanOrEqual(before);
  expect(sandbox.commands.run).toHaveBeenCalledWith(
    expect.stringContaining('"action":"screenshot"'),
    expect.objectContaining({ user: "root" }),
  );
  expect(sandbox.files.remove).toHaveBeenCalledWith(
    expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
    expect.anything(),
  );
});

it("fails closed and removes the temporary file when fresh capture fails", async () => {
  const sandbox = fixture(1);
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
    ),
  ).rejects.toThrow("Browser preview disconnected");
  expect(sandbox.files.read).not.toHaveBeenCalled();
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
});

/** The JSON request argument of each daemon-helper command that was run. */
const daemonRequests = (run: jest.Mock) =>
  run.mock.calls
    .map(([command]) => command as string)
    .filter((command) => command.includes('"action":'))
    .map((command) =>
      JSON.parse(command.slice(command.lastIndexOf(" '") + 2, -1)),
    );

it.each([
  ["omitted", undefined],
  ["false", false],
  ["true", true],
] as const)(
  "asks for the owned-listener port only when freshness is not required (%s)",
  async (_case, requireFresh) => {
    const sandbox = fixture();
    const before = Date.now();
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
    );
    const requests = daemonRequests(sandbox.commands.run);
    expect(requests[0]).toEqual(
      requireFresh
        ? { action: "stream_status" }
        : { action: "stream_status", owned_port: true },
    );
    // The returned port still goes through the unchanged frame bridge.
    expect(sandbox.commands.run.mock.calls[1][0]).toMatch(/ 1234 frame$/);
    if (requireFresh) {
      // A fresh capture still requests its own unchanged daemon screenshot.
      expect(requests.slice(1)).toEqual([
        {
          action: "screenshot",
          path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
          format: "jpeg",
          quality: 65,
        },
      ]);
      expect(result.capturedAt).toBeGreaterThanOrEqual(before);
      expect(result.image).toBe(
        `data:image/jpeg;base64,${fresh.toString("base64")}`,
      );
    } else {
      // A cached frame is never relabeled fresh.
      expect(requests).toHaveLength(1);
      expect(result.capturedAt).toBe(0);
      expect(sandbox.files.read).not.toHaveBeenCalled();
    }
  },
);

it("keeps stream-port lookups for TAKE, input and relays on the daemon request", async () => {
  const sandbox = fixture();
  await expect(
    getPrivateStreamPort(sandbox as unknown as Sandbox, location, "default"),
  ).resolves.toBe(1234);
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status" },
  ]);
});

it("keeps cached-frame age unknown for ordinary viewing", async () => {
  const sandbox = fixture();
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
  );
  expect(result.capturedAt).toBe(0);
  expect(result.image).toBe(
    `data:image/jpeg;base64,${cached.toString("base64")}`,
  );
  expect(sandbox.files.read).not.toHaveBeenCalled();
});

it("resizes only the bound browser session and returns a fresh frame", async () => {
  const sandbox = fixture();
  const result = await resizeBrowserViewport(
    sandbox as unknown as Sandbox,
    location,
    "child-one",
    390,
    844,
  );
  expect(sandbox.commands.run).toHaveBeenCalledWith(
    expect.stringContaining(
      '"action":"viewport","width":390,"height":844,"deviceScaleFactor":1',
    ),
    expect.objectContaining({ user: "root" }),
  );
  // A resize requires a fresh frame, so its port lookup never opts in.
  expect(daemonRequests(sandbox.commands.run)[1]).toEqual({
    action: "stream_status",
  });
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
  expect(result.browserSessionName).toBe("child-one");
  expect(result.width).toBe(390);
  expect(result.height).toBe(844);
});

it("does not return a new image or coordinate space when resizing fails", async () => {
  const sandbox = fixture(0, 1);
  await expect(
    resizeBrowserViewport(
      sandbox as unknown as Sandbox,
      location,
      "child-one",
      390,
      844,
    ),
  ).rejects.toThrow("Browser preview disconnected");
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  expect(sandbox.files.read).not.toHaveBeenCalled();
});

it("rejects unbounded viewport dimensions before executing a command", async () => {
  const sandbox = fixture();
  await expect(
    resizeBrowserViewport(
      sandbox as unknown as Sandbox,
      location,
      "default",
      99999,
      844,
    ),
  ).rejects.toThrow("Invalid browser viewport");
  expect(sandbox.commands.run).not.toHaveBeenCalled();
});

it.each(["unavailable", "not_observed", "unreadable"])(
  "preserves the finite %s observation without invented open details",
  async (status) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        open_receipt_version: 1,
        open_receipt_status: status,
        open_phase: "PRIVATE",
      }),
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed.mock.calls[0][0]).toMatchObject({
      capture_open_receipt_version: 1,
      capture_open_receipt_status: status,
    });
    expect(observed.mock.calls[0][0]).not.toHaveProperty("capture_open_phase");
  },
);

it("rejects partial open details without retaining supplied private values", async () => {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode: 2,
    stderr: "PRIVATE",
    stdout: JSON.stringify({
      open_receipt_version: 1,
      open_receipt_status: "recorded",
      open_phase: "completed",
      open_exit: 999,
      open_session_matches: "PRIVATE",
      open_age: "PRIVATE",
    }),
  });
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed.mock.calls[0][0]).not.toHaveProperty(
    "capture_open_receipt_version",
  );
  expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
});

it.each([
  [1, "unavailable"],
  [1, "not_observed"],
  [1, "unreadable"],
  [1, "recorded", "completed", 0, "selected_session", "older", "after"],
  [1, "recorded", "completed", 0, "all_sessions", "older", "after"],
  [1, "recorded", "started", "none", "other_session", "lt10s", "unavailable"],
])("projects only the bounded retained close tuple %j", async (...tuple) => {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode: 2,
    stderr: "PRIVATE",
    stdout: JSON.stringify({
      close_receipt: tuple,
      open_receipt_version: 1,
      open_receipt_status: "recorded",
      open_phase: "completed",
      open_exit: 0,
      open_session_matches: true,
      open_age: "older",
    }),
  });
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed.mock.calls[0][0]).toMatchObject({
    capture_close_receipt_version: 1,
    capture_close_receipt_status: tuple[1],
  });
  if (tuple[1] === "recorded") {
    expect(observed.mock.calls[0][0]).toMatchObject({
      capture_close_phase: tuple[2],
      capture_close_exit_code: tuple[3],
      capture_close_scope: tuple[4],
      capture_close_age: tuple[5],
      capture_close_open_order: tuple[6],
    });
  } else
    expect(observed.mock.calls[0][0]).not.toHaveProperty("capture_close_phase");
  expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
});

it.each([
  [1, "recorded", "completed", 256, "selected_session", "older", "after"],
  [1, "recorded", "started", 0, "selected_session", "older", "after"],
  [1, "recorded", "completed", 0, "PRIVATE", "older", "after"],
  [1, "recorded", "completed", 0, "selected_session", "PRIVATE", "after"],
  [1, "recorded", "completed", 0, "selected_session", "older", "PRIVATE"],
  [1, "unavailable", "PRIVATE"],
  [1, "recorded", "completed", 0, "other_session", "older", "after"],
])(
  "rejects malformed close details without leaking supplied values: %j",
  async (...tuple) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        close_receipt: tuple,
        open_receipt_version: 1,
        open_receipt_status: "recorded",
        open_phase: "completed",
        open_exit: 0,
        open_session_matches: true,
        open_age: "older",
      }),
    });
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    expect(observed.mock.calls[0][0]).not.toHaveProperty(
      "capture_close_receipt_version",
    );
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it("censors close/open ordering when valid same-session open evidence is absent", async () => {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode: 2,
    stderr: "PRIVATE",
    stdout: JSON.stringify({
      close_receipt: [
        1,
        "recorded",
        "completed",
        0,
        "selected_session",
        "older",
        "after",
      ],
    }),
  });
  sandbox.commands.run.mockRejectedValueOnce(error);
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    ),
  ).rejects.toBe(error);
  expect(observed.mock.calls[0][0]).not.toHaveProperty(
    "capture_close_receipt_version",
  );
});

it.each([
  [
    "command exit",
    () =>
      new CommandExitError({
        exitCode: 17,
        stdout: "PRIVATE",
        stderr: "PRIVATE",
      }),
    "command_exit",
    17,
  ],
  ["SDK timeout", () => new TimeoutError("PRIVATE"), "timeout", "none"],
  ["other error", () => new Error("PRIVATE"), "other_error", "none"],
  ["non-Error throw", () => "PRIVATE", "thrown_value", "none"],
] as const)(
  "attributes a relay renewal %s without exporting its contents",
  (_label, createError, kind, exitCode) => {
    const fields = browserRelayRenewFailureContext(createError());
    expect(fields).toEqual({
      relay_renew_diagnostic_version: 2,
      relay_renew_error_kind: kind,
      relay_renew_command_exit_code: exitCode,
    });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  },
);

it.each([true, false])(
  "retains a bounded renewal reason when the SDK throws: %s",
  async (throws) => {
    const sandbox = fixture();
    const result = {
      exitCode: RELAY_RENEW_FAILURE_CODES.lock_busy,
      stdout: "PRIVATE",
      stderr: "PRIVATE",
    };
    const original = new CommandExitError(result);
    if (throws) sandbox.commands.run.mockRejectedValueOnce(original);
    else sandbox.commands.run.mockResolvedValueOnce(result);

    const failure = await renewBrowserRelay(
      sandbox as unknown as Sandbox,
      location,
      "PRIVATE",
      Date.now() + 25_000,
    ).catch((error: unknown) => error);

    if (throws) expect(failure).toBe(original);
    else expect(failure).toBeInstanceOf(BrowserPreviewUnavailable);
    expect(browserRelayRenewFailureContext(failure)).toEqual({
      relay_renew_diagnostic_version: 2,
      relay_renew_error_kind: "command_exit",
      relay_renew_command_exit_code: RELAY_RENEW_FAILURE_CODES.lock_busy,
      relay_renew_failure_reason: "lock_busy",
    });
  },
);

it.each(["accessor", "unbounded", "unreadable"] as const)(
  "preserves renewal recovery and privacy for %s SDK exit data",
  async (shape) => {
    const error = new CommandExitError({
      exitCode: 1,
      stdout: "PRIVATE",
      stderr: "PRIVATE",
    });
    const getter = jest.fn(() => {
      throw new Error("PRIVATE getter");
    });
    const result =
      shape === "unreadable"
        ? new Proxy({}, { getOwnPropertyDescriptor: getter })
        : shape === "accessor"
          ? Object.defineProperty({}, "exitCode", { get: getter })
          : { exitCode: "PRIVATE" };
    Object.defineProperty(error, "result", { value: result });
    const fields = browserRelayRenewFailureContext(error);
    expect(fields).toEqual({
      relay_renew_diagnostic_version: 2,
      relay_renew_error_kind:
        shape === "unreadable" ? "unreadable" : "command_exit",
      relay_renew_command_exit_code: "other",
    });
    expect(getter).toHaveBeenCalledTimes(shape === "unreadable" ? 1 : 0);
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
  },
);

it.each([
  [[1, 0, 0], "missing", "unavailable"],
  [[1, 1, 0], "invalid", "unavailable"],
  [[1, 2, 0], "unreadable", "unavailable"],
  [[1, 3, 0], "recorded", "unavailable"],
  [[1, 3, 1], "recorded", "not_found"],
  [[1, 3, 2], "recorded", "same_uid"],
  [[1, 3, 3], "recorded", "other_uid"],
  [[1, 3, 4], "recorded", "permission"],
  [[1, 3, 5], "recorded", "other"],
  [[1, 0, 2], undefined, undefined],
  [[2, 3, 2], undefined, undefined],
  [[1, 3, "PRIVATE"], undefined, undefined],
  [[1, 3, 6], undefined, undefined],
  [[1, 3, 2, "PRIVATE"], undefined, undefined],
])(
  "projects only the closed process tuple beside a matching successful OPEN (%#)",
  async (p1, status, visibility) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        p1,
        open_receipt_version: 1,
        open_receipt_status: "recorded",
        open_phase: "completed",
        open_exit: 0,
        open_session_matches: true,
        open_age: "older",
        private: "PRIVATE",
      }),
    });
    sandbox.commands.run.mockRejectedValue(error);
    const observe = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ),
    ).rejects.toBe(error);
    const context = observe.mock.calls[0][0];
    expect(context.capture_daemon_process_version).toBe(status ? 1 : undefined);
    expect(context.capture_daemon_pid_status).toBe(status);
    expect(context.capture_daemon_process_visibility).toBe(visibility);
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  { open_session_matches: false },
  { open_phase: "started", open_exit: "none" },
  { open_exit: 1 },
  { open_receipt_version: 2 },
])(
  "keeps process evidence censored without a matching successful OPEN: %j",
  async (override) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: JSON.stringify({
        p1: [1, 3, 2],
        open_receipt_version: 1,
        open_receipt_status: "recorded",
        open_phase: "completed",
        open_exit: 0,
        open_session_matches: true,
        open_age: "older",
        ...override,
      }),
    });
    sandbox.commands.run.mockRejectedValue(error);
    const observe = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ),
    ).rejects.toBe(error);
    expect(
      observe.mock.calls[0][0].capture_daemon_process_version,
    ).toBeUndefined();
  },
);

const startedSelectedWrapper = {
  wrapper_receipt_version: 1,
  wrapper_action: "open",
  wrapper_phase: "started",
  wrapper_exit: "none",
  wrapper_session_matches: true,
  wrapper_age: "lt60s",
};
/** Reject the selected-session status helper with exactly this failure packet. */
async function observeDaemonFailure(exitCode: number, packet: string) {
  const sandbox = fixture();
  const error = new CommandExitError({
    exitCode,
    stderr: "PRIVATE",
    stdout: packet,
  });
  sandbox.commands.run.mockRejectedValue(error);
  const observe = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observe,
    ),
  ).rejects.toBe(error);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  return observe.mock.calls[0][0];
}

it.each([
  [0, "unavailable"],
  [1, "not_found"],
  [2, "incarnation_changed"],
  [3, "same_incarnation_visible"],
  [4, "same_incarnation_zombie"],
  [5, "permission"],
  [6, "other"],
  [7, undefined],
  [-1, undefined],
  [1.5, undefined],
  ["3", undefined],
  [[1, 3], undefined],
  ["PRIVATE", undefined],
])(
  "projects only a closed started-wrapper incarnation code %j at the response deadline",
  async (w1, visibility) => {
    const context = await observeDaemonFailure(
      3,
      JSON.stringify({
        deadline: [1, "awaiting_response"],
        ...startedSelectedWrapper,
        w1,
        private: "PRIVATE",
      }),
    );
    expect(context).toMatchObject({
      capture_command_exit_code: 3,
      capture_deadline_phase: "awaiting_response",
      capture_wrapper_phase: "started",
      capture_wrapper_session_matches: true,
    });
    expect(context.capture_wrapper_process_version).toBe(
      visibility ? 1 : undefined,
    );
    expect(context.capture_wrapper_process_visibility).toBe(visibility);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  { wrapper_phase: "completed", wrapper_exit: 0 },
  { wrapper_session_matches: false },
  { wrapper_age: "PRIVATE" },
  { wrapper_receipt_version: 2 },
  { wrapper_receipt_version: undefined },
])(
  "keeps incarnation visibility censored without a valid selected STARTED receipt: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...startedSelectedWrapper,
        ...override,
        w1: 1,
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(context).not.toHaveProperty("capture_wrapper_process_version");
    expect(context).not.toHaveProperty("capture_wrapper_process_visibility");
  },
);

it.each([false, true])(
  "retains every maximal existing field beside the incarnation code within the unchanged cap (oversized:%s)",
  async (oversized) => {
    const packet = JSON.stringify({
      diagnostic_reason: "sockets_stat",
      diagnostic_error: "not_directory",
      ...startedSelectedWrapper,
      wrapper_action: "version",
      wrapper_age: "unknown",
      open_receipt_version: 1,
      open_receipt_status: "recorded",
      h1: 3,
      open_phase: "completed",
      open_exit: 0,
      open_session_matches: true,
      open_age: "unknown",
      close_receipt: [
        1,
        "recorded",
        "completed",
        "other",
        "selected_session",
        "unknown",
        "same_time",
      ],
      open_idle: [1, "unparsed"],
      p1: [1, 2, 0],
      w1: 4,
      cv: [1, 1, 999999999],
    });
    expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(544);
    const context = await observeDaemonFailure(
      2,
      oversized ? packet + " ".repeat(545 - packet.length) : packet,
    );
    if (oversized) {
      expect(context).not.toHaveProperty("capture_wrapper_process_visibility");
      expect(context).not.toHaveProperty("capture_precondition_reason");
    } else
      expect(context).toMatchObject({
        capture_precondition_reason: "sockets_stat",
        capture_precondition_error: "not_directory",
        capture_wrapper_action: "version",
        capture_wrapper_phase: "started",
        capture_wrapper_exit_code: "none",
        capture_wrapper_session_matches: true,
        capture_wrapper_age: "unknown",
        capture_wrapper_process_version: 1,
        capture_wrapper_process_visibility: "same_incarnation_zombie",
        capture_wrapper_other_cli_completed: true,
        capture_wrapper_option_prefix_completed: true,
        capture_open_exit_code: 0,
        capture_open_idle_env: "unparsed",
        capture_daemon_pid_status: "unreadable",
        capture_close_scope: "selected_session",
        capture_close_open_order: "same_time",
        capture_cli_at_prepare_status: "measured",
      });
  },
);

const successfulSelectedOpen = {
  open_receipt_version: 1,
  open_receipt_status: "recorded",
  open_phase: "completed",
  open_exit: 0,
  open_session_matches: true,
  open_age: "lt60s",
};

it.each([
  [0, "unavailable"],
  [1, "owned_socket"],
  [2, "missing"],
  [3, "invalid"],
  [4, "unreadable"],
  [undefined, undefined], // An older writer is unmeasured, not missing.
  [5, undefined],
  [-1, undefined],
  [1.5, undefined],
  ["1", undefined],
  [[1, 1], undefined],
  [null, undefined],
  ["PRIVATE", undefined],
])(
  "projects only a closed at-return socket code %j beside a matching successful OPEN",
  async (os1, status) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        p1: [1, 0, 0],
        os1,
        private: "PRIVATE",
      }),
    );
    // The capture-time precondition and process tuple remain independent.
    expect(context).toMatchObject({
      capture_precondition_reason: "socket_stat",
      capture_precondition_error: "missing",
      capture_open_exit_code: 0,
      capture_daemon_pid_status: "missing",
    });
    expect(context.capture_open_socket_return_version).toBe(
      status ? 1 : undefined,
    );
    expect(context.capture_open_socket_return_status).toBe(status);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  { open_session_matches: false },
  { open_phase: "started", open_exit: "none" },
  { open_exit: 1 },
  { open_exit: "other" },
  { open_receipt_version: 2 },
  { open_receipt_status: "unreadable" },
])(
  "keeps the at-return socket code censored without a matching successful OPEN: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        ...override,
        os1: 1,
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(context).not.toHaveProperty("capture_open_socket_return_version");
    expect(context).not.toHaveProperty("capture_open_socket_return_status");
  },
);

it.each([false, true])(
  "retains every field beside the at-return socket code in a packet at the unchanged cap (oversized:%s)",
  async (oversized) => {
    // The daemon drops os1 when "other" exits would exceed 544; 255 still fits.
    const packet = JSON.stringify({
      diagnostic_reason: "sockets_stat",
      diagnostic_error: "not_directory",
      wrapper_receipt_version: 1,
      wrapper_action: "version",
      wrapper_phase: "completed",
      wrapper_exit: 255,
      wrapper_session_matches: false,
      wrapper_age: "unknown",
      ...successfulSelectedOpen,
      open_age: "unknown",
      h1: 3,
      close_receipt: [
        1,
        "recorded",
        "completed",
        "other",
        "selected_session",
        "unknown",
        "same_time",
      ],
      open_idle: [1, "unparsed"],
      p1: [1, 2, 0],
      os1: 4,
      cv: [1, 1, 999999999],
    });
    expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(544);
    // Exactly at the cap is parsed; one more byte rejects the whole packet.
    const context = await observeDaemonFailure(
      2,
      packet + " ".repeat((oversized ? 545 : 544) - packet.length),
    );
    if (oversized) {
      expect(context).not.toHaveProperty("capture_open_socket_return_status");
      expect(context).not.toHaveProperty("capture_precondition_reason");
    } else
      expect(context).toMatchObject({
        capture_precondition_reason: "sockets_stat",
        capture_precondition_error: "not_directory",
        capture_wrapper_phase: "completed",
        capture_wrapper_exit_code: 255,
        capture_wrapper_session_matches: false,
        capture_wrapper_other_cli_completed: true,
        capture_wrapper_option_prefix_completed: true,
        capture_open_exit_code: 0,
        capture_open_idle_env: "unparsed",
        capture_daemon_pid_status: "unreadable",
        capture_open_socket_return_version: 1,
        capture_open_socket_return_status: "unreadable",
        capture_close_scope: "selected_session",
        capture_close_open_order: "same_time",
        capture_cli_at_prepare_status: "measured",
      });
  },
);

it.each([
  [0, "wait"],
  [1, "snapshot"],
  [2, "screenshot"],
  [3, "open"],
  [4, "close"],
  [5, "version"],
  [6, "other"],
  [7, "unparsed"],
  [8, undefined],
  [-1, undefined],
  [1.5, undefined],
  ["0", undefined],
  [true, undefined],
  [null, undefined],
  [[1, 0], undefined],
  ["PRIVATE", undefined],
  [undefined, undefined], // An older writer is unmeasured, not a category.
])(
  "projects only a closed declared-command code %j beside a valid wrapper receipt",
  async (k1, category) => {
    const context = await observeDaemonFailure(
      3,
      JSON.stringify({
        deadline: [1, "awaiting_response"],
        ...startedSelectedWrapper,
        w1: 3,
        k1,
        private: "PRIVATE",
      }),
    );
    expect(context).toMatchObject({
      capture_command_exit_code: 3,
      capture_deadline_phase: "awaiting_response",
      capture_wrapper_phase: "started",
      capture_wrapper_process_visibility: "same_incarnation_visible",
    });
    expect(context.capture_wrapper_command_version).toBe(
      category ? 1 : undefined,
    );
    expect(context.capture_wrapper_command_class).toBe(category);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([{ wrapper_receipt_version: 2 }, { wrapper_age: "PRIVATE" }, {}])(
  "keeps the declared-command code censored without a valid wrapper receipt: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...(Object.keys(override).length ? startedSelectedWrapper : {}),
        ...override,
        k1: 0,
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(context).not.toHaveProperty("capture_wrapper_command_version");
    expect(context).not.toHaveProperty("capture_wrapper_command_class");
  },
);

it.each([
  [[1, 0], "unavailable", undefined],
  [[1, 1, 39003], "measured", [0, 39, 3]],
  [[1, 1, 999999999], "measured", [999, 999, 999]],
  [[1, 1, 0], "measured", [0, 0, 0]],
  [[1, 2], "missing", undefined],
  [[1, 3], "unreadable", undefined],
  [[1, 4], "unparsed", undefined],
  [undefined, undefined, undefined], // An older helper or dropped at the cap.
  [[1, 1], undefined, undefined],
  [[1, 2, 39003], undefined, undefined],
  [[1, 1, 39003, 0], undefined, undefined],
  [[1, 1, -1], undefined, undefined],
  [[1, 1, 1000000000], undefined, undefined],
  [[1, 1, 39.3], undefined, undefined],
  [[1, 1, "39003"], undefined, undefined],
  [[1, true], undefined, undefined],
  [[1, 5], undefined, undefined],
  [[1, 1.5], undefined, undefined],
  [[2, 1, 39003], undefined, undefined],
  [{ 0: 1, 1: 2, length: 2 }, undefined, undefined],
  ["PRIVATE", undefined, undefined],
])(
  "projects only a strict selected daemon version declaration %j",
  async (dv, status, semver) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        p1: [1, 3, 2],
        cv: [1, 2],
        dv,
        private: "PRIVATE",
      }),
    );
    // The capture-time precondition and CLI-at-prepare check stay independent.
    expect(context).toMatchObject({
      capture_precondition_reason: "socket_stat",
      capture_precondition_error: "missing",
      capture_daemon_pid_status: "recorded",
      capture_cli_at_prepare_status: "not_checked",
    });
    expect(context).not.toHaveProperty("capture_cli_at_prepare_major");
    expect(context.capture_daemon_version_file_version).toBe(
      status ? 1 : undefined,
    );
    expect(context.capture_daemon_version_file_status).toBe(status);
    expect([
      context.capture_daemon_version_file_major,
      context.capture_daemon_version_file_minor,
      context.capture_daemon_version_file_patch,
    ]).toEqual(semver ?? [undefined, undefined, undefined]);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  { open_session_matches: false },
  { open_phase: "started", open_exit: "none" },
  { open_exit: 1 },
  { open_exit: "other" },
  { open_receipt_version: 2 },
  { open_receipt_status: "unreadable" },
])(
  "keeps the version declaration censored without a matching successful OPEN: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        ...override,
        dv: [1, 1, 39003],
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(context).not.toHaveProperty("capture_daemon_version_file_version");
    expect(context).not.toHaveProperty("capture_daemon_version_file_status");
    expect(context).not.toHaveProperty("capture_daemon_version_file_major");
  },
);

it.each([false, true])(
  "parses the declaration and category beside every existing field in a packet at the unchanged cap (oversized:%s)",
  async (oversized) => {
    // The daemon's near-cap deadline shape with every optional code present.
    const packet = JSON.stringify({
      deadline: [1, "awaiting_response"],
      ...startedSelectedWrapper,
      wrapper_action: "other",
      ...successfulSelectedOpen,
      h1: 3,
      close_receipt: [1, "unavailable"],
      open_idle: [1, "unparsed"],
      p1: [1, 3, 2],
      os1: 1,
      w1: 3,
      k1: 0,
      dv: [1, 1, 39003],
      cv: [1, 2],
    });
    expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(544);
    const context = await observeDaemonFailure(
      3,
      packet + " ".repeat((oversized ? 545 : 544) - packet.length),
    );
    if (oversized) {
      expect(context).not.toHaveProperty("capture_wrapper_command_class");
      expect(context).not.toHaveProperty("capture_daemon_version_file_status");
      expect(context).not.toHaveProperty("capture_deadline_phase");
    } else {
      expect(context).toMatchObject({
        capture_deadline_phase: "awaiting_response",
        capture_wrapper_action: "other",
        capture_wrapper_phase: "started",
        capture_wrapper_process_visibility: "same_incarnation_visible",
        capture_wrapper_command_version: 1,
        capture_wrapper_command_class: "wait",
        capture_open_exit_code: 0,
        capture_open_socket_return_status: "owned_socket",
        capture_daemon_process_visibility: "same_uid",
        capture_daemon_version_file_version: 1,
        capture_daemon_version_file_status: "measured",
        capture_daemon_version_file_major: 0,
        capture_daemon_version_file_minor: 39,
        capture_daemon_version_file_patch: 3,
        capture_cli_at_prepare_status: "not_checked",
      });
      // Plain data only: the observer receives no accessors.
      expect(
        Object.values(Object.getOwnPropertyDescriptors(context)).every(
          (descriptor) => "value" in descriptor,
        ),
      ).toBe(true);
    }
  },
);

it("retains closed frame-decode context without exposing stdout or retrying", async () => {
  const sandbox = fixture();
  sandbox.commands.run.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "{PRIVATE_INCOMPLETE",
  });
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observed,
    ),
  ).rejects.toThrow();
  expect(observed).toHaveBeenCalledWith(
    expect.objectContaining({
      capture_stage: "frame_decode",
      capture_frame_decode_version: 1,
      capture_frame_stdout_size: "lt1k",
      capture_frame_stdout_shape: "object_prefix",
      capture_frame_parse_error_kind: "syntax_error",
    }),
  );
  expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
});

it.each([
  ["", "empty", "empty"],
  [" \n\t", "lt1k", "edge_whitespace"],
  ["PRIVATE_TEXT", "lt1k", "other"],
  ['{ "PRIVATE": }', "lt1k", "object_edges"],
  ["{" + "x".repeat(1024), "1k_lt64k", "object_prefix"],
  ["{" + "x".repeat(65536), "64k_lt1m", "object_prefix"],
  ["{" + "x".repeat(1048576), "gte1m", "object_prefix"],
  [undefined, "nonstring", "nonstring"],
])(
  "classifies malformed frame stdout by bounded size and edges (%#)",
  async (stdout, size, shape) => {
    const sandbox = fixture();
    sandbox.commands.run.mockResolvedValueOnce({
      exitCode: 0,
      stdout: stdout as string,
    });
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        1234,
        observed,
      ),
    ).rejects.toThrow();
    expect(observed.mock.calls[0][0]).toMatchObject({
      capture_frame_decode_version: 1,
      capture_frame_stdout_size: size,
      capture_frame_stdout_shape: shape,
      capture_frame_parse_error_kind: "syntax_error",
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  },
);

it("isolates a frame-decode observer failure and leaves valid frames free of diagnostics", async () => {
  const sandbox = fixture();
  sandbox.commands.run.mockResolvedValueOnce({
    exitCode: 0,
    stdout: "PRIVATE_TEXT",
  });
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      () => {
        throw new Error("PRIVATE_OBSERVER");
      },
    ),
  ).rejects.toThrow("Browser preview disconnected");
  const observed = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observed,
    ),
  ).resolves.toMatchObject({ width: 800, height: 600 });
  expect(observed).not.toHaveBeenCalled();
});

it("delivers v2 bridge categories through the actual capture helper without changing its rejection", async () => {
  const sandbox = fixture();
  const original = new CommandExitError({
    exitCode: 6,
    stdout: JSON.stringify({
      bridge_failure: [
        2,
        "error",
        "message_received",
        "none",
        "protocol_masked",
        22,
      ],
    }),
    stderr: "PRIVATE_FRAME",
  });
  sandbox.commands.run.mockRejectedValueOnce(original);
  const observe = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observe,
    ),
  ).rejects.toBe(original);
  expect(observe).toHaveBeenCalledWith(
    expect.objectContaining({
      capture_stage: "frame_bridge",
      capture_bridge_diagnostic_version: 2,
      capture_bridge_error_reason: "protocol_masked",
      capture_bridge_node_major: 22,
    }),
  );
  expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
});

it.each([true, false])(
  "forwards a frame watchdog receipt through the actual capture observer (SDK throws: %s)",
  async (throws) => {
    const sandbox = fixture();
    const result = {
      exitCode: 3,
      stdout: JSON.stringify({
        bridge_failure: [3, "deadline", "awaiting_frame", "none"],
      }),
      stderr: "PRIVATE_FRAME",
    };
    const original = new CommandExitError(result);
    if (throws) sandbox.commands.run.mockRejectedValueOnce(original);
    else sandbox.commands.run.mockResolvedValueOnce(result);
    const observe = jest.fn();
    const capture = captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observe,
    );
    if (throws) await expect(capture).rejects.toBe(original);
    else await expect(capture).rejects.toThrow();
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_stage: "frame_bridge",
        capture_error_kind: throws ? "command_exit" : "preview_unavailable",
        capture_command_exit_code: throws ? 3 : "none",
        capture_bridge_diagnostic_version: 3,
        capture_bridge_failure: "deadline",
        capture_bridge_phase: "awaiting_frame",
        capture_bridge_close_code: "none",
      }),
    );
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([
  [true, [4, "deadline", "message_received", "none", 16, "false"], true],
  [false, [4, "deadline", "message_received", "none", 3, "not_observed"], true],
  [true, [4, "deadline", "awaiting_frame", "none", 1, "false"], false],
  [false, [4, "deadline", "message_received", "none", 17, "true"], false],
] as const)(
  "forwards only a consistent v4 status summary through the capture observer (SDK throws: %s, %#)",
  async (throws, tuple, accepted) => {
    const sandbox = fixture();
    const result = {
      exitCode: 3,
      stdout: JSON.stringify({ bridge_failure: tuple }),
      stderr: "PRIVATE_FRAME",
    };
    const original = new CommandExitError(result);
    if (throws) sandbox.commands.run.mockRejectedValueOnce(original);
    else sandbox.commands.run.mockResolvedValueOnce(result);
    const observe = jest.fn();
    const capture = captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observe,
    );
    if (throws) await expect(capture).rejects.toBe(original);
    else await expect(capture).rejects.toThrow();
    expect(observe).toHaveBeenCalledTimes(1);
    const context = observe.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_stage: "frame_bridge",
      capture_command_exit_code: throws ? 3 : "none",
    });
    const bridge = Object.fromEntries(
      Object.entries(context).filter(([key]) =>
        key.startsWith("capture_bridge_"),
      ),
    );
    expect(bridge).toEqual(
      accepted
        ? {
            capture_bridge_diagnostic_version: 4,
            capture_bridge_failure: "deadline",
            capture_bridge_phase: tuple[2],
            capture_bridge_close_code: "none",
            capture_bridge_nonframe_message_count: tuple[4],
            capture_bridge_status_message_connected: tuple[5],
          }
        : {},
    );
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
  },
);
