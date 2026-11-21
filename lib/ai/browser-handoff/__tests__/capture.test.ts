import {
  BrowserPreviewRefreshDeferred,
  BrowserPreviewUnavailable,
  browserSessionReadFailureContext,
  browserPauseFailureContext,
  browserRelayRenewFailureContext,
  captureBrowserFrame,
  getActiveBrowserSessionName,
  getPrivateStreamPort,
  renewBrowserRelay,
  resizeBrowserViewport,
  setAgentBrowserPaused,
} from "../server";
import { CommandExitError, TimeoutError } from "@e2b/code-interpreter";
import type { Sandbox } from "@e2b/code-interpreter";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import path from "node:path";
import { createHash } from "node:crypto";
import { RELAY_RENEW_FAILURE_CODES } from "../relay-program";
import {
  BROWSER_BRIDGE_PROGRAM,
  browserBridgeCommand,
} from "../bridge-program";
import {
  BROWSER_DAEMON_PROGRAM,
  BROWSER_DAEMON_RESPONSE_VALIDATIONS,
  BROWSER_DAEMON_SCREENSHOT_REFUSALS,
  BROWSER_DAEMON_WAIT_DEFERRED,
  BROWSER_DAEMON_OPEN_DEFERRED,
  BROWSER_DAEMON_SESSION_CLOSED,
  browserDaemonCommand,
} from "../daemon-program";

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
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command: string) => {
        if (
          stage === "fresh_screenshot"
            ? command.includes('"action":"screenshot"')
            : !command.includes('"action":"stream_status"')
        )
          throw error;
        return run(command);
      }),
    );
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
      sandbox.commands.run.mockResolvedValueOnce(
        sdkHandle(async () => ({
          exitCode: 0,
          stdout: JSON.stringify({ data: { port: 1234 } }),
        })),
      );
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
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    }),
  );
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
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command) => {
        if (command.includes('"action":"screenshot"')) throw error;
        return run(command);
      }),
    );
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
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command) => {
        if (command.includes('"action":"screenshot"')) throw error;
        return run(command);
      }),
    );
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
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command) => {
        if (
          freshStage
            ? command.includes('"action":"screenshot"')
            : !command.includes('"action":"stream_status"')
        )
          throw error;
        return run(command);
      }),
    );
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

/** An e2b command handle whose wait settles once with the command outcome. */
function sdkHandle(settle: () => Promise<unknown>) {
  return {
    pid: 1,
    wait: jest.fn(settle),
    kill: jest.fn(),
    disconnect: jest.fn(),
  };
}

/**
 * Model e2b `commands.run`: a background start resolves a handle and only its
 * wait settles with the outcome; a foreground run settles with it directly.
 */
function sdkRun(outcome: (command: string) => Promise<unknown>) {
  return async (command: string, options?: { background?: boolean }) =>
    options?.background ? sdkHandle(() => outcome(command)) : outcome(command);
}

function fixture(screenshotExitCode = 0, viewportExitCode = 0) {
  const sandbox = {
    commands: {
      run: jest.fn(
        sdkRun(async (command: string) => {
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
      ),
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

/** The fixture with one stream-status helper output for every status request. */
function statusFixture(stdout: string) {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) =>
      command.includes('"action":"stream_status"')
        ? { exitCode: 0, stdout }
        : run(command),
    ),
  );
  return sandbox;
}

it("returns a typed frameless deferral for an opted-in fresh capture during a verified WAIT", async () => {
  const sandbox = statusFixture(BROWSER_DAEMON_WAIT_DEFERRED);
  const observe = jest.fn();
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    observe,
    { deferDuringWait: true },
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(BrowserPreviewRefreshDeferred);
  expect(outcome).not.toBeInstanceOf(BrowserPreviewUnavailable);
  // Not a capture failure: no diagnostics, bridge, screenshot or file access.
  expect(observe).not.toHaveBeenCalled();
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status", defer_wait: true },
  ]);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  expect(sandbox.files.getInfo).not.toHaveBeenCalled();
  expect(sandbox.files.remove).not.toHaveBeenCalled();
});

it.each([
  ["no WAIT proof (a port reply)", JSON.stringify({ data: { port: 1234 } })],
  [
    "a daemon reply carrying the deferral key",
    JSON.stringify({
      id: "hackerai-preview",
      success: true,
      wait_deferred: 1,
      data: { port: 1234 },
    }),
  ],
])(
  "keeps the strict fresh capture after an opt-in with %s",
  async (_case, stdout) => {
    const sandbox = statusFixture(stdout);
    const before = Date.now();
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      jest.fn(),
      { deferDuringWait: true },
    );
    const requests = daemonRequests(sandbox.commands.run);
    // The screenshot keeps the same opt-in; its helper declines without a WAIT.
    expect(requests).toEqual([
      { action: "stream_status", defer_wait: true },
      {
        action: "screenshot",
        path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
        format: "jpeg",
        quality: 65,
        defer_wait: true,
      },
    ]);
    expect(sandbox.commands.run.mock.calls[1][0]).toMatch(/ 1234 frame$/);
    expect(result.image).toBe(
      `data:image/jpeg;base64,${fresh.toString("base64")}`,
    );
    expect(result.capturedAt).toBeGreaterThanOrEqual(before);
  },
);

it("treats the deferral literal as an ordinary invalid status reply without the opt-in", async () => {
  const sandbox = statusFixture(BROWSER_DAEMON_WAIT_DEFERRED);
  const observe = jest.fn();
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    observe,
  ).catch((error: unknown) => error);
  // Old readers keep the exact strict failure and its diagnostics.
  expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
  expect((outcome as BrowserPreviewUnavailable).state).toBe("loading");
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status" },
  ]);
  expect(observe.mock.calls).toEqual([
    [
      {
        capture_stage: "stream_status",
        capture_error_kind: "preview_unavailable",
        capture_command_exit_code: "none",
      },
    ],
  ]);
});

it("returns a typed OPEN deferral for an opted-in fresh status behind a verified running OPEN", async () => {
  const sandbox = statusFixture(BROWSER_DAEMON_OPEN_DEFERRED);
  const observe = jest.fn();
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    observe,
    // The passive GET's existing status options ride beside the new opt-in.
    {
      deferDuringWait: true,
      deferDuringOpen: true,
      recognizeClosed: true,
      observeStatusProgress: true,
    },
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(BrowserPreviewRefreshDeferred);
  expect((outcome as BrowserPreviewRefreshDeferred).reason).toBe("open");
  // Not a capture failure: no diagnostics, bridge, screenshot or file access.
  expect(observe).not.toHaveBeenCalled();
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    {
      action: "stream_status",
      defer_wait: true,
      defer_open: true,
      recognize_closed: true,
      observe_progress: true,
    },
  ]);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  expect(sandbox.files.getInfo).not.toHaveBeenCalled();
  expect(sandbox.files.remove).not.toHaveBeenCalled();
});

it("keeps the existing WAIT deferral reason when both kinds are negotiated", async () => {
  const sandbox = statusFixture(BROWSER_DAEMON_WAIT_DEFERRED);
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    jest.fn(),
    { deferDuringWait: true, deferDuringOpen: true },
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(BrowserPreviewRefreshDeferred);
  expect((outcome as BrowserPreviewRefreshDeferred).reason).toBe("wait");
});

it.each<[string, Record<string, boolean>, string, number]>([
  ["only WAIT was negotiated", { deferDuringWait: true }, "", 0],
  ["nothing was negotiated", {}, "", 0],
  ["the status exited nonzero", { deferDuringOpen: true }, "", 3],
  [
    "a daemon reply carries the key",
    { deferDuringOpen: true },
    JSON.stringify({ id: "hackerai-preview", success: true, open_deferred: 1 }),
    0,
  ],
])(
  "keeps the strict status failure when %s",
  async (_case, options, stdout, exitCode) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command: string) =>
        command.includes('"action":"stream_status"')
          ? { exitCode, stdout: stdout || BROWSER_DAEMON_OPEN_DEFERRED }
          : run(command),
      ),
    );
    const observe = jest.fn();
    const outcome = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
      options,
    ).catch((error: unknown) => error);
    expect(outcome).not.toBeInstanceOf(BrowserPreviewRefreshDeferred);
    expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
    // Each keeps its original state and stream_status diagnostics.
    expect((outcome as BrowserPreviewUnavailable).state).toBe(
      exitCode === 0 ? "loading" : "closed",
    );
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({
      capture_stage: "stream_status",
    });
    expect(
      daemonRequests(sandbox.commands.run).every(
        (request) =>
          "defer_open" in request === (options.deferDuringOpen === true),
      ),
    ).toBe(true);
  },
);

it("never asks the fresh screenshot to defer for an OPEN or honors its literal there", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) =>
      command.includes('"action":"screenshot"')
        ? { exitCode: 0, stdout: BROWSER_DAEMON_OPEN_DEFERRED }
        : run(command),
    ),
  );
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    jest.fn(),
    { deferDuringOpen: true },
  );
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status", defer_open: true },
    {
      action: "screenshot",
      path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
      format: "jpeg",
      quality: 65,
    },
  ]);
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
});

it.each([
  ["a cached view", false, undefined],
  ["a caller-supplied port", true, 1234],
] as const)(
  "never requests an OPEN deferral for %s",
  async (_case, requireFresh, streamPort) => {
    const sandbox = fixture();
    await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
      streamPort,
      undefined,
      { deferDuringOpen: true },
    );
    expect(
      daemonRequests(sandbox.commands.run).some(
        (request) => "defer_open" in request,
      ),
    ).toBe(false);
  },
);

/** The fixture with one fresh-screenshot helper outcome after a successful status. */
function screenshotFixture(outcome: () => Promise<unknown>) {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) =>
      command.includes('"action":"screenshot"') ? outcome() : run(command),
    ),
  );
  return sandbox;
}

it("defers an opted-in fresh screenshot when a WAIT starts after status succeeded", async () => {
  const sandbox = screenshotFixture(async () => ({
    exitCode: 0,
    stdout: BROWSER_DAEMON_WAIT_DEFERRED,
  }));
  const observe = jest.fn();
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    observe,
    { deferDuringWait: true, recognizeClosed: true },
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(BrowserPreviewRefreshDeferred);
  // Status answered, then the screenshot yielded: no failure context.
  expect(observe).not.toHaveBeenCalled();
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status", defer_wait: true, recognize_closed: true },
    {
      action: "screenshot",
      path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
      format: "jpeg",
      quality: 65,
      defer_wait: true,
      recognize_closed: true,
    },
  ]);
  // The helper sent no screenshot: no fresh data I/O or cleanup call.
  expect(sandbox.files.getInfo).not.toHaveBeenCalled();
  expect(sandbox.files.read).not.toHaveBeenCalled();
  expect(sandbox.files.remove).not.toHaveBeenCalled();
});

it.each([
  ["an unnegotiated capture", false, BROWSER_DAEMON_WAIT_DEFERRED],
  [
    "a daemon reply carrying the deferral key",
    true,
    JSON.stringify({ id: "hackerai-preview", success: true, wait_deferred: 1 }),
  ],
])(
  "continues the fresh screenshot for %s",
  async (_case, deferDuringWait, stdout) => {
    const sandbox = screenshotFixture(async () => ({ exitCode: 0, stdout }));
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      jest.fn(),
      { deferDuringWait },
    );
    expect(result.image).toBe(
      `data:image/jpeg;base64,${fresh.toString("base64")}`,
    );
    expect(
      daemonRequests(sandbox.commands.run).every(
        (request) => "defer_wait" in request === deferDuringWait,
      ),
    ).toBe(true);
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [
    "a returned nonzero result",
    async () => ({ exitCode: 3, stdout: BROWSER_DAEMON_WAIT_DEFERRED }),
  ],
  [
    "an SDK exit rejection",
    async () => {
      throw new CommandExitError({
        exitCode: 3,
        stderr: "",
        stdout: BROWSER_DAEMON_WAIT_DEFERRED,
      });
    },
  ],
])(
  "keeps the strict screenshot failure and cleanup for the literal on %s",
  async (_case, outcome) => {
    const sandbox = screenshotFixture(outcome);
    const observe = jest.fn();
    const error = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
      { deferDuringWait: true },
    ).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(BrowserPreviewRefreshDeferred);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe.mock.calls[0][0]).toMatchObject({
      capture_stage: "fresh_screenshot",
    });
    expect(sandbox.files.getInfo).not.toHaveBeenCalled();
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["a cached view", false, undefined],
  ["a caller-supplied port", true, 1234],
] as const)(
  "never requests a deferral for %s",
  async (_case, requireFresh, streamPort) => {
    const sandbox = statusFixture(BROWSER_DAEMON_WAIT_DEFERRED);
    const run = sandbox.commands.run.getMockImplementation()!;
    sandbox.commands.run.mockImplementation(async (command, options) =>
      command.includes('"owned_port":true')
        ? { exitCode: 0, stdout: JSON.stringify({ data: { port: 1234 } }) }
        : run(command, options),
    );
    await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
      streamPort,
      undefined,
      { deferDuringWait: true },
    );
    const requests = daemonRequests(sandbox.commands.run);
    expect(requests.some((request) => "defer_wait" in request)).toBe(false);
    expect(requests[0]).toEqual(
      streamPort === undefined
        ? { action: "stream_status", owned_port: true }
        : expect.objectContaining({ action: "screenshot" }),
    );
  },
);

it.each([
  ["a fresh view", true, {}, { action: "stream_status" }],
  ["a cached view", false, {}, { action: "stream_status", owned_port: true }],
  [
    "a WAIT-deferring fresh view",
    true,
    { deferDuringWait: true },
    { action: "stream_status", defer_wait: true },
  ],
] as const)(
  "returns the existing closed state for a verified close on %s",
  async (_case, requireFresh, extra, request) => {
    const sandbox = statusFixture(BROWSER_DAEMON_SESSION_CLOSED);
    const outcome = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
      undefined,
      jest.fn(),
      { ...extra, recognizeClosed: true },
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
    expect((outcome as BrowserPreviewUnavailable).state).toBe("closed");
    // The opt-in rides beside each unchanged status form; nothing else runs.
    expect(daemonRequests(sandbox.commands.run)).toEqual([
      { ...request, recognize_closed: true },
    ]);
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(sandbox.files.getInfo).not.toHaveBeenCalled();
  },
);

it.each([false, true])(
  "treats the closed literal as an ordinary invalid status reply without the opt-in (fresh:%s)",
  async (requireFresh) => {
    const sandbox = statusFixture(BROWSER_DAEMON_SESSION_CLOSED);
    const outcome = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
      undefined,
      jest.fn(),
      { deferDuringWait: true },
    ).catch((error: unknown) => error);
    // Older readers and every other caller keep the exact strict result.
    expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
    expect((outcome as BrowserPreviewUnavailable).state).toBe("loading");
    expect(
      daemonRequests(sandbox.commands.run).some(
        (request) => "recognize_closed" in request,
      ),
    ).toBe(false);
  },
);

it("keeps the normal capture when an opted-in status returns a port", async () => {
  const sandbox = fixture();
  const result = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    jest.fn(),
    { recognizeClosed: true },
  );
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    { action: "stream_status", recognize_closed: true },
    {
      action: "screenshot",
      path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
      format: "jpeg",
      quality: 65,
      recognize_closed: true,
    },
  ]);
  expect(result.image).toBe(
    `data:image/jpeg;base64,${fresh.toString("base64")}`,
  );
});

it("never asks to recognize a close for a caller-supplied port", async () => {
  const sandbox = statusFixture(BROWSER_DAEMON_SESSION_CLOSED);
  await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    1234,
    undefined,
    { recognizeClosed: true },
  );
  expect(daemonRequests(sandbox.commands.run)).toEqual([
    {
      action: "screenshot",
      path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
      format: "jpeg",
      quality: 65,
    },
  ]);
});

it.each([
  ["a fresh view", {}, {}],
  [
    "a WAIT-deferring fresh view",
    { deferDuringWait: true },
    { defer_wait: true },
  ],
] as const)(
  "returns the existing closed state when the fresh screenshot finds a verified close on %s",
  async (_case, extra, flags) => {
    const sandbox = screenshotFixture(async () => ({
      exitCode: 0,
      stdout: BROWSER_DAEMON_SESSION_CLOSED,
    }));
    const observe = jest.fn();
    const outcome = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
      { ...extra, recognizeClosed: true },
    ).catch((error: unknown) => error);
    expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
    expect((outcome as BrowserPreviewUnavailable).state).toBe("closed");
    const requests = daemonRequests(sandbox.commands.run);
    // One status and one screenshot: no extra command or retry.
    expect(requests).toEqual([
      { action: "stream_status", ...flags, recognize_closed: true },
      {
        action: "screenshot",
        path: expect.stringMatching(/\/preview-[a-f0-9]{32}\.jpg$/),
        format: "jpeg",
        quality: 65,
        ...flags,
        recognize_closed: true,
      },
    ]);
    expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
    // No screenshot read, but the daemon may already have written the file.
    expect(sandbox.files.getInfo).not.toHaveBeenCalled();
    expect(sandbox.files.read).not.toHaveBeenCalled();
    expect(sandbox.files.remove.mock.calls).toEqual([
      [requests[1].path, expect.objectContaining({ user: "root" })],
    ]);
    expect(observe.mock.calls).toEqual([
      [
        {
          capture_stage: "fresh_screenshot",
          capture_error_kind: "preview_unavailable",
          capture_command_exit_code: "none",
        },
      ],
    ]);
  },
);

it.each<[string, boolean, number | undefined, string]>([
  ["without the opt-in", false, undefined, BROWSER_DAEMON_SESSION_CLOSED],
  ["for a caller-supplied port", true, 1234, BROWSER_DAEMON_SESSION_CLOSED],
  ["for a non-literal marker", true, undefined, '{"session_closed":true}'],
  [
    "for the literal with a trailing newline",
    true,
    undefined,
    BROWSER_DAEMON_SESSION_CLOSED + "\n",
  ],
  [
    "for a daemon reply carrying the marker",
    true,
    undefined,
    JSON.stringify({
      id: "hackerai-preview",
      success: true,
      session_closed: 1,
    }),
  ],
])(
  "continues the strict fresh screenshot %s",
  async (_case, recognizeClosed, streamPort, stdout) => {
    const sandbox = screenshotFixture(async () => ({ exitCode: 0, stdout }));
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      streamPort,
      jest.fn(),
      { recognizeClosed },
    );
    expect(result.image).toBe(
      `data:image/jpeg;base64,${fresh.toString("base64")}`,
    );
    expect(sandbox.files.read).toHaveBeenCalledTimes(1);
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  },
);

it("keeps the strict screenshot failure for the closed literal on a nonzero exit", async () => {
  const sandbox = screenshotFixture(async () => {
    throw new CommandExitError({
      exitCode: 6,
      stderr: "",
      stdout: BROWSER_DAEMON_SESSION_CLOSED,
    });
  });
  const outcome = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    jest.fn(),
    { recognizeClosed: true },
  ).catch((error: unknown) => error);
  expect(outcome).toBeInstanceOf(CommandExitError);
  expect(sandbox.files.getInfo).not.toHaveBeenCalled();
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
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
  const observe = jest.fn();
  const result = await resizeBrowserViewport(
    sandbox as unknown as Sandbox,
    location,
    "child-one",
    390,
    844,
    observe,
  );
  expect(sandbox.commands.run).toHaveBeenCalledWith(
    expect.stringContaining(
      '"action":"viewport","width":390,"height":844,"deviceScaleFactor":1',
    ),
    expect.objectContaining({ user: "root" }),
  );
  // An observer keeps the foreground command and its 7s budget.
  expect(sandbox.commands.run.mock.calls[0][1]).toEqual({
    user: "root",
    timeoutMs: 7_000,
  });
  expect(observe).not.toHaveBeenCalled();
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

describe("viewport failure context", () => {
  const resize = (sandbox: ReturnType<typeof fixture>, observe: jest.Mock) =>
    resizeBrowserViewport(
      sandbox as unknown as Sandbox,
      location,
      "child-one",
      390,
      844,
      observe,
    ).catch((error: unknown) => error);

  it.each([
    [3, 3],
    [300, "other"],
  ])(
    "reports a returned daemon exit %s as the resize command",
    async (exitCode, reported) => {
      const sandbox = fixture(0, exitCode);
      const observe = jest.fn();
      const outcome = await resize(sandbox, observe);
      expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
      expect((outcome as Error).message).toBe("Browser preview disconnected");
      expect(observe.mock.calls).toEqual([
        [
          {
            viewport_diagnostic_version: 1,
            viewport_failure_phase: "resize_command",
            viewport_error_kind: "command_exit",
            viewport_command_exit_code: reported,
          },
        ],
      ]);
      expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      "an SDK nonzero exit",
      () =>
        new CommandExitError({ exitCode: 7, stderr: "PRIVATE", stdout: "" }),
      "command_exit",
      7,
    ],
    ["an SDK timeout", () => new TimeoutError("PRIVATE"), "timeout", "none"],
  ])(
    "reports %s from the resize command without its output",
    async (_case, createError, kind, exitCode) => {
      const sandbox = fixture();
      const error = createError();
      sandbox.commands.run.mockRejectedValueOnce(error);
      const observe = jest.fn();
      expect(await resize(sandbox, observe)).toBe(error);
      expect(observe.mock.calls).toEqual([
        [
          {
            viewport_diagnostic_version: 1,
            viewport_failure_phase: "resize_command",
            viewport_error_kind: kind,
            viewport_command_exit_code: exitCode,
          },
        ],
      ]);
      expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
      expect(sandbox.files.read).not.toHaveBeenCalled();
    },
  );

  it("reports a returned strict-frame failure after a successful resize", async () => {
    const sandbox = fixture(1);
    const observe = jest.fn();
    const outcome = await resize(sandbox, observe);
    expect(outcome).toBeInstanceOf(BrowserPreviewUnavailable);
    expect((outcome as Error).message).toBe("Browser preview disconnected");
    expect(observe.mock.calls).toEqual([
      [
        {
          viewport_diagnostic_version: 1,
          viewport_failure_phase: "capture_frame",
          viewport_error_kind: "preview_unavailable",
          viewport_command_exit_code: "none",
        },
      ],
    ]);
    // The viewport command succeeded and the strict capture still cleaned up.
    expect(daemonRequests(sandbox.commands.run)[0]).toMatchObject({
      action: "viewport",
    });
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  });

  it("reports an SDK screenshot exit as the capture, not the resize", async () => {
    const error = new CommandExitError({
      exitCode: 2,
      stderr: "PRIVATE",
      stdout: "",
    });
    const sandbox = screenshotFixture(async () => {
      throw error;
    });
    const observe = jest.fn();
    expect(await resize(sandbox, observe)).toBe(error);
    expect(observe.mock.calls).toEqual([
      [
        {
          viewport_diagnostic_version: 1,
          viewport_failure_phase: "capture_frame",
          viewport_error_kind: "command_exit",
          viewport_command_exit_code: 2,
        },
      ],
    ]);
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
  });

  it("keeps the original rejection when the observer throws", async () => {
    const sandbox = fixture();
    const error = new TimeoutError("PRIVATE");
    sandbox.commands.run.mockRejectedValueOnce(error);
    const observe = jest.fn(() => {
      throw new Error("observer");
    });
    expect(await resize(sandbox, observe)).toBe(error);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  });
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
  [0, "none"],
  [1, "help"],
  [2, "version"],
  [3, "help_and_version"],
  [undefined, undefined], // An older writer is unmeasured, not "none".
  [4, undefined],
  [-1, undefined],
  [1.5, undefined],
  ["1", undefined],
  [null, undefined],
])(
  "projects only a closed OPEN informational-token code %j beside a matching successful OPEN",
  async (o1, flags) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        p1: [1, 0, 0],
        os1: 2,
        o1,
        private: "PRIVATE",
      }),
    );
    // Invalid or missing codes omit only the new pair; other context remains.
    expect(context).toMatchObject({
      capture_precondition_reason: "socket_stat",
      capture_open_exit_code: 0,
      capture_daemon_pid_status: "missing",
      capture_open_socket_return_status: "missing",
    });
    expect(context.capture_open_info_version).toBe(flags ? 1 : undefined);
    expect(context.capture_open_info_flags).toBe(flags);
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each([
  { open_session_matches: false },
  { open_phase: "started", open_exit: "none" },
  { open_exit: 1 },
  { open_receipt_status: "unreadable" },
])(
  "keeps the OPEN informational-token code censored without a matching successful OPEN: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...successfulSelectedOpen,
        ...override,
        o1: 3,
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    expect(context).not.toHaveProperty("capture_open_info_version");
    expect(context).not.toHaveProperty("capture_open_info_flags");
  },
);

/** The status helper's missing-socket packet after a plain missing-socket OPEN. */
const missingDirectoryPacket = (override: Record<string, unknown> = {}) =>
  JSON.stringify({
    diagnostic_reason: "socket_stat",
    diagnostic_error: "missing",
    ...successfulSelectedOpen,
    p1: [1, 0, 0],
    os1: 2,
    o1: 0,
    sd1: 0,
    private: "PRIVATE",
    ...override,
  });

it.each([
  [0, "managed_directory"],
  [1, "unset_or_empty"],
  [2, "different_directory"],
])(
  "projects the plain missing-socket OPEN's socket-directory code %j as one versioned field",
  async (sd1, declaration) => {
    const context = await observeDaemonFailure(
      2,
      missingDirectoryPacket({ sd1 }),
    );
    const { capture_open_socket_directory_v1: projected, ...existing } =
      context;
    expect(projected).toBe(declaration);
    // Every existing field is unchanged beside the one new field.
    expect(existing).toEqual(
      await observeDaemonFailure(2, missingDirectoryPacket({ sd1: undefined })),
    );
    expect(existing).toMatchObject({
      capture_stage: "stream_status",
      capture_precondition_error: "missing",
      capture_open_socket_return_status: "missing",
      capture_open_info_flags: "none",
      capture_daemon_pid_status: "missing",
    });
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it.each<[string, Record<string, unknown>, number?]>([
  ["an older writer", { sd1: undefined }],
  ["an out-of-range code", { sd1: 3 }],
  ["a negative code", { sd1: -1 }],
  ["a fractional code", { sd1: 0.5 }],
  ["a string code", { sd1: "0" }],
  ["a tuple", { sd1: [1, 0] }],
  ["a private value", { sd1: "PRIVATE" }],
  ["an owned socket at return", { os1: 1 }],
  ["an unmeasured socket at return", { os1: undefined }],
  ["help tokens", { o1: 1 }],
  ["unmeasured informational tokens", { o1: undefined }],
  ["another session's OPEN", { open_session_matches: false }],
  ["a failed OPEN", { open_exit: 1 }],
  ["a STARTED OPEN", { open_phase: "started", open_exit: "none" }],
  ["an unreadable status socket", { diagnostic_error: "permission" }],
  ["a missing sockets directory", { diagnostic_reason: "sockets_stat" }],
  ["a deadline exit", {}, 3],
  ["a refused response", { r1: [1, 2] }, 5],
])(
  "omits the socket-directory field for %s",
  async (_case, override, exitCode = 2) => {
    const context = await observeDaemonFailure(
      exitCode,
      missingDirectoryPacket(override),
    );
    expect(context.capture_command_exit_code).toBe(exitCode);
    expect(context).not.toHaveProperty("capture_open_socket_directory_v1");
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

it("omits the socket-directory field outside the stream_status stage", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const error = new CommandExitError({
    exitCode: 2,
    stdout: missingDirectoryPacket(),
    stderr: "PRIVATE",
  });
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    }),
  );
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
  const context = observed.mock.calls[0][0];
  // The same packet's existing fields still project at this stage.
  expect(context).toMatchObject({
    capture_stage: "fresh_screenshot",
    capture_open_socket_return_status: "missing",
    capture_open_info_flags: "none",
  });
  expect(context).not.toHaveProperty("capture_open_socket_directory_v1");
});

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
  [true, [5, "deadline", "message_received", "none", 9, "true", "false"], true],
  [
    false,
    [5, "deadline", "message_received", "none", 4, "true", "other"],
    true,
  ],
  [
    true,
    [5, "deadline", "message_received", "none", 3, "true", "not_observed"],
    false,
  ],
  [
    false,
    [5, "deadline", "message_received", "none", 3, "true", "PRIVATE"],
    false,
  ],
] as const)(
  "forwards only a consistent status summary through the capture observer (SDK throws: %s, %#)",
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
            capture_bridge_diagnostic_version: tuple[0],
            capture_bridge_failure: "deadline",
            capture_bridge_phase: tuple[2],
            capture_bridge_close_code: "none",
            capture_bridge_nonframe_message_count: tuple[4],
            capture_bridge_status_message_connected: tuple[5],
            // Older v4 helpers never claimed screencasting.
            ...(tuple[0] === 5
              ? { capture_bridge_status_message_screencasting: tuple[6] }
              : {}),
          }
        : {},
    );
    expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([true, false])(
  "keeps the original frame rejection when the observer throws on a v5 summary (SDK throws: %s)",
  async (throws) => {
    const sandbox = fixture();
    const result = {
      exitCode: 3,
      stdout: JSON.stringify({
        bridge_failure: [
          5,
          "deadline",
          "message_received",
          "none",
          3,
          "true",
          "false",
        ],
      }),
      stderr: "PRIVATE_FRAME",
    };
    const original = new CommandExitError(result);
    if (throws) sandbox.commands.run.mockRejectedValueOnce(original);
    else sandbox.commands.run.mockResolvedValueOnce(result);
    const observe = jest.fn(() => {
      throw new Error("PRIVATE observer");
    });
    const capture = captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
      observe,
    );
    if (throws) await expect(capture).rejects.toBe(original);
    else
      await expect(capture).rejects.toBeInstanceOf(BrowserPreviewUnavailable);
    expect(observe).toHaveBeenCalledTimes(1);
    expect(observe).toHaveBeenCalledWith(
      expect.objectContaining({
        capture_bridge_diagnostic_version: 5,
        capture_bridge_status_message_connected: "true",
        capture_bridge_status_message_screencasting: "false",
      }),
    );
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  },
);

/**
 * Execute the real frame bridge against a stream that sends these messages,
 * then let its watchdog expire. Returns the first exit and its stdout.
 */
function runFrameBridge(command: string, messages: string[]) {
  expect(command).toBe(browserBridgeCommand(1234, "frame"));
  const listeners = new Map<string, (value?: unknown) => void>();
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  let stdout = "";
  let exitCode: number | undefined;
  runInNewContext(BROWSER_BRIDGE_PROGRAM, {
    WebSocket: class {
      addEventListener(name: string, listener: (value?: unknown) => void) {
        listeners.set(name, listener);
      }
      close() {}
    },
    process: {
      argv: ["node", "1234", "frame"],
      stdout: {
        write: (text: string, written?: (error?: Error | null) => void) => {
          stdout += text;
          written?.(null);
        },
      },
      exit: (code: number) => {
        exitCode ??= code;
      },
    },
    setTimeout: (callback: () => void) => {
      timers.set(++nextTimer, callback);
      return nextTimer;
    },
    clearTimeout: (id: number) => timers.delete(id),
  });
  listeners.get("open")!();
  for (const data of messages) listeners.get("message")!({ data });
  for (const callback of timers.values()) callback();
  return { exitCode: exitCode!, stdout };
}

/** A non-fresh preview whose owned-port lookup carries no connected claim. */
function bridgeSandbox(messages: string[], throws: boolean) {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const thrown: unknown[] = [];
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) => {
      if (command.includes('"action":"stream_status"')) return run(command);
      const result = runFrameBridge(command, messages);
      if (result.exitCode === 0 || !throws) return result;
      const error = new CommandExitError({ ...result, stderr: "PRIVATE" });
      thrown.push(error);
      throw error;
    }),
  );
  return { sandbox, thrown };
}

const daemonStatus = (connected: unknown, screencasting: unknown) =>
  JSON.stringify({
    type: "status",
    connected,
    screencasting,
    url: "PRIVATE_URL",
  });
const daemonFrame = JSON.stringify({
  type: "frame",
  data: cached.toString("base64"),
  metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 },
});

describe.each([true, false])(
  "non-fresh preview over the owned stream port (SDK throws: %s)",
  (throws) => {
    it.each([
      ["no attached browser", [daemonStatus(false, false)]],
      [
        "no attached browser before a frame",
        [daemonStatus(false, false), daemonFrame],
      ],
    ])(
      "answers closed promptly when the daemon reports %s",
      async (_case, messages) => {
        const { sandbox } = bridgeSandbox(messages, throws);
        const observe = jest.fn();
        const failure = await captureBrowserFrame(
          sandbox as unknown as Sandbox,
          location,
          "default",
          false,
          undefined,
          observe,
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(BrowserPreviewUnavailable);
        expect((failure as BrowserPreviewUnavailable).state).toBe("closed");
        // The shortcut lookup omits connected, so only the bridge can see it.
        expect(sandbox.commands.run.mock.calls[0][0]).toContain(
          '"owned_port":true',
        );
        expect(sandbox.commands.run).toHaveBeenCalledTimes(2);
        expect(observe).toHaveBeenCalledTimes(1);
        expect(observe.mock.calls[0][0]).toMatchObject({
          capture_stage: "frame_bridge",
          capture_error_kind: throws ? "command_exit" : "preview_unavailable",
          capture_command_exit_code: throws ? 7 : "none",
        });
        expect(JSON.stringify(observe.mock.calls)).not.toContain("PRIVATE");
      },
    );

    it("keeps a connected claim without a frame on the disconnected watchdog", async () => {
      const { sandbox, thrown } = bridgeSandbox(
        [daemonStatus(true, false)],
        throws,
      );
      const observe = jest.fn();
      const failure = await captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        false,
        undefined,
        observe,
      ).catch((error: unknown) => error);
      if (throws) expect(failure).toBe(thrown[0]);
      else
        expect(failure).toEqual(new BrowserPreviewUnavailable("disconnected"));
      expect(observe.mock.calls[0][0]).toMatchObject({
        capture_command_exit_code: throws ? 3 : "none",
        capture_bridge_diagnostic_version: 5,
        capture_bridge_failure: "deadline",
        capture_bridge_status_message_connected: "true",
        capture_bridge_status_message_screencasting: "false",
      });
    });

    it("returns the frame after a connected claim", async () => {
      const { sandbox } = bridgeSandbox(
        [daemonStatus(true, true), daemonFrame],
        throws,
      );
      await expect(
        captureBrowserFrame(sandbox as unknown as Sandbox, location, "default"),
      ).resolves.toMatchObject({
        image: `data:image/jpeg;base64,${cached.toString("base64")}`,
        width: 800,
        height: 600,
        capturedAt: 1,
      });
    });
  },
);

it("trusts only an own numeric bridge exit 7 as closed", async () => {
  const getter = jest.fn(() => 7);
  const sdkResult = Object.defineProperty(
    { stdout: "", stderr: "PRIVATE" },
    "exitCode",
    { get: getter, enumerable: true },
  );
  const thrown = new CommandExitError(sdkResult as never);
  // The existing nonzero check reads this one; classification must not trust it.
  const returned = Object.defineProperty({ stdout: "" }, "exitCode", {
    get: () => 7,
  });
  const cases: [unknown, "throws" | "returns"][] = [
    [thrown, "throws"],
    [new CommandExitError({ exitCode: "7", stdout: "" } as never), "throws"],
    [returned, "returns"],
    [{ exitCode: 8, stdout: "" }, "returns"],
  ];
  for (const [outcome, kind] of cases) {
    const sandbox = fixture();
    if (kind === "throws") sandbox.commands.run.mockRejectedValueOnce(outcome);
    else sandbox.commands.run.mockResolvedValueOnce(outcome as never);
    const failure = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      1234,
    ).catch((error: unknown) => error);
    if (kind === "throws") expect(failure).toBe(outcome);
    else expect(failure).toEqual(new BrowserPreviewUnavailable("disconnected"));
  }
  expect(getter).not.toHaveBeenCalled();
});

it("keeps exit 7 from other capture stages unclassified", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const original = new CommandExitError({
    exitCode: 7,
    stdout: "",
    stderr: "PRIVATE",
  });
  sandbox.commands.run.mockImplementation(async (command: string) => {
    if (command.includes('"action":"screenshot"')) throw original;
    return run(command);
  });
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      1234,
    ),
  ).rejects.toBe(original);
});

/**
 * Execute the real daemon helper from a sandbox command against an owned socket
 * that answers with one line. No receipts exist, as for a worker without them.
 */
function runDaemonHelper(command: string, line: string) {
  const payload = /'(\{[^']*\})'$/.exec(command)![1];
  // The command carries exactly the helper program executed here.
  expect(command).toBe(
    browserDaemonCommand(location.directory, "default", JSON.parse(payload)),
  );
  const socket = Object.assign(new EventEmitter(), {
    setEncoding: jest.fn(),
    write: jest.fn(),
    destroy: jest.fn(),
  });
  const exits: number[] = [];
  let stdout = "";
  runInNewContext(BROWSER_DAEMON_PROGRAM, {
    require: (name: string) => {
      if (name === "node:path") return path;
      if (name === "node:crypto") return { createHash };
      if (name === "node:net") return { createConnection: () => socket };
      if (name === "node:fs")
        return {
          constants: { O_RDONLY: 0, O_NOFOLLOW: 256, O_NONBLOCK: 2048 },
          lstatSync: (file: string) => {
            if (file.endsWith(".json"))
              throw Object.assign(new Error("PRIVATE receipt"), {
                code: "ENOENT",
              });
            return {
              uid: 1000,
              mode: 0o700,
              isDirectory: () => !file.endsWith(".sock"),
              isSocket: () => file.endsWith("/sockets/default.sock"),
            };
          },
        };
      throw new Error("Unexpected module");
    },
    process: {
      argv: ["node", location.directory, "default", payload],
      getuid: () => 1000,
      platform: "linux",
      stdout: { write: (text: string) => (stdout += text) },
      exit: (code: number) => exits.push(code),
    },
    Buffer,
    setTimeout: () => 1,
    clearTimeout: jest.fn(),
  });
  socket.emit("connect");
  socket.emit("data", line + "\n");
  expect(exits).toHaveLength(1);
  expect(socket.write).toHaveBeenCalledTimes(1);
  return { exitCode: exits[0], stdout };
}

/** Route one daemon stage's command through the real helper; others use the fixture. */
function helperSandbox(
  stage: "stream_status" | "fresh_screenshot",
  line: string,
) {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const thrown: unknown[] = [];
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) => {
      if (
        !command.includes(
          stage === "fresh_screenshot"
            ? '"action":"screenshot"'
            : '"action":"stream_status"',
        )
      )
        return run(command);
      const { exitCode, stdout } = runDaemonHelper(command, line);
      if (exitCode === 0) return { exitCode, stdout };
      // The SDK rejects a nonzero exit with the command's result.
      const error = new CommandExitError({
        exitCode,
        stdout,
        stderr: "PRIVATE",
      });
      thrown.push(error);
      throw error;
    }),
  );
  return { sandbox, thrown };
}

it.each(
  (
    [
      ["invalid JSON", "PRIVATE_BODY", "invalid_json"],
      ["null", "null", "invalid_envelope"],
      ["an array", '["hackerai-preview",true]', "invalid_envelope"],
      ["a primitive", '"PRIVATE"', "invalid_envelope"],
      ["another ID", '{"id":"PRIVATE","success":true}', "id_mismatch"],
      [
        "success false",
        '{"id":"hackerai-preview","success":false,"error":"PRIVATE"}',
        "success_false",
      ],
      [
        "a non-boolean success",
        '{"id":"hackerai-preview","success":"true","data":"PRIVATE"}',
        "success_other",
      ],
    ] as const
  ).flatMap(([name, line, validation]) =>
    (["stream_status", "fresh_screenshot"] as const).map(
      (stage) => [name, stage, line, validation] as const,
    ),
  ),
)(
  "classifies %s from the real helper at %s exit5 without changing the capture failure",
  async (_case, stage, line, validation) => {
    const { sandbox, thrown } = helperSandbox(stage, line);
    const observed = jest.fn();
    const failure = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      stage === "fresh_screenshot",
      undefined,
      observed,
    ).catch((error: unknown) => error);
    expect(thrown).toHaveLength(1);
    expect(failure).toBe(thrown[0]);
    expect(observed.mock.calls).toEqual([
      [
        {
          capture_stage: stage,
          capture_error_kind: "command_exit",
          capture_command_exit_code: 5,
          capture_cli_at_prepare_diagnostic_version: 1,
          capture_cli_at_prepare_status: "unavailable",
          capture_response_diagnostic_version: 1,
          capture_response_validation: validation,
          // Only the screenshot action classifies its unrecognized error.
          ...(stage === "fresh_screenshot" &&
            validation === "success_false" && {
              capture_screenshot_refusal_version: 1,
              capture_screenshot_refusal: "other_or_unavailable",
            }),
        },
      ],
    ]);
    expect(JSON.stringify(observed.mock.calls)).not.toMatch(
      /PRIVATE|hackerai-preview/,
    );
    // No added request or retry; the fresh path keeps its cleanup.
    expect(sandbox.commands.run).toHaveBeenCalledTimes(
      stage === "fresh_screenshot" ? 3 : 1,
    );
    expect(sandbox.files.remove).toHaveBeenCalledTimes(
      stage === "fresh_screenshot" ? 1 : 0,
    );
    expect(sandbox.files.read).not.toHaveBeenCalled();
  },
);

it.each(["stream_status", "fresh_screenshot"] as const)(
  "captures unchanged through the real helper's successful %s response",
  async (stage) => {
    const { sandbox, thrown } = helperSandbox(
      stage,
      '{"id":"hackerai-preview","success":true,"data":{"port":1234}}',
    );
    const observed = jest.fn();
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      stage === "fresh_screenshot",
      undefined,
      observed,
    );
    expect(thrown).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
    expect(result.image).toBe(
      `data:image/jpeg;base64,${(stage === "fresh_screenshot" ? fresh : cached).toString("base64")}`,
    );
    expect(sandbox.commands.run).toHaveBeenCalledTimes(
      stage === "fresh_screenshot" ? 3 : 2,
    );
  },
);

it.each<[unknown, (typeof BROWSER_DAEMON_SCREENSHOT_REFUSALS)[number]]>([
  ["Browser not launched", "browser_not_launched"],
  ["No active page", "no_active_page"],
  ["Failed to decode screenshot: PRIVATE", "decode_failed"],
  ["Failed to save screenshot to /PRIVATE/preview.jpg: PRIVATE", "save_failed"],
  ["Browser not launched PRIVATE", "other_or_unavailable"],
  [{ message: "No active page" }, "other_or_unavailable"],
])(
  "classifies the real helper's fresh screenshot error %j as %s without changing the capture failure",
  async (reason, refusal) => {
    const { sandbox, thrown } = helperSandbox(
      "fresh_screenshot",
      JSON.stringify({
        id: "hackerai-preview",
        success: false,
        error: reason,
        data: "PRIVATE",
      }),
    );
    const observed = jest.fn();
    const failure = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observed,
    ).catch((error: unknown) => error);
    expect(thrown).toHaveLength(1);
    expect(failure).toBe(thrown[0]);
    expect(observed.mock.calls).toEqual([
      [
        {
          capture_stage: "fresh_screenshot",
          capture_error_kind: "command_exit",
          capture_command_exit_code: 5,
          capture_cli_at_prepare_diagnostic_version: 1,
          capture_cli_at_prepare_status: "unavailable",
          capture_response_diagnostic_version: 1,
          capture_response_validation: "success_false",
          capture_screenshot_refusal_version: 1,
          capture_screenshot_refusal: refusal,
        },
      ],
    ]);
    const serialized = JSON.stringify(observed.mock.calls);
    expect(serialized).not.toMatch(/PRIVATE|hackerai-preview|Failed|\//);
    if (typeof reason === "string") expect(serialized).not.toContain(reason);
    // No added request or retry; the screenshot file is still removed.
    expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
    expect(sandbox.files.read).not.toHaveBeenCalled();
  },
);

it.each([
  [
    "another ID",
    "fresh_screenshot",
    '{"id":"PRIVATE","success":false,"error":"Browser not launched"}',
    "id_mismatch",
  ],
  [
    "the status action",
    "stream_status",
    '{"id":"hackerai-preview","success":false,"error":"Browser not launched"}',
    "success_false",
  ],
] as const)(
  "leaves the screenshot error unclassified for %s from the real helper",
  async (_case, stage, line, validation) => {
    const { sandbox, thrown } = helperSandbox(stage, line);
    const observed = jest.fn();
    const failure = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      stage === "fresh_screenshot",
      undefined,
      observed,
    ).catch((error: unknown) => error);
    expect(failure).toBe(thrown[0]);
    const context = observed.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_stage: stage,
      capture_command_exit_code: 5,
      capture_response_validation: validation,
    });
    expect(context).not.toHaveProperty("capture_screenshot_refusal_version");
    expect(context).not.toHaveProperty("capture_screenshot_refusal");
  },
);

it.each<
  [
    string,
    "stream_status" | "fresh_screenshot",
    unknown,
    unknown,
    (typeof BROWSER_DAEMON_SCREENSHOT_REFUSALS)[number] | undefined,
  ]
>([
  [
    "the last known code",
    "fresh_screenshot",
    [1, 3],
    [1, 4],
    "other_or_unavailable",
  ],
  ["an older writer", "fresh_screenshot", [1, 3], undefined, undefined],
  ["the status stage", "stream_status", [1, 3], [1, 0], undefined],
  ["another refusal", "fresh_screenshot", [1, 2], [1, 0], undefined],
  ["an unknown code", "fresh_screenshot", [1, 3], [1, 5], undefined],
  ["another version", "fresh_screenshot", [1, 3], [2, 0], undefined],
])(
  "accepts the screenshot refusal tuple only after a decoded success_false (%s)",
  async (_case, stage, r1, s1, refusal) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const error = new CommandExitError({
      exitCode: 5,
      stdout: JSON.stringify({ r1, s1, private: "PRIVATE" }),
      stderr: "PRIVATE",
    });
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command: string) => {
        if (
          command.includes(
            stage === "fresh_screenshot"
              ? '"action":"screenshot"'
              : '"action":"stream_status"',
          )
        )
          throw error;
        return run(command);
      }),
    );
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        stage === "fresh_screenshot",
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    const context = observed.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_stage: stage,
      capture_command_exit_code: 5,
    });
    if (refusal)
      expect(context).toMatchObject({
        capture_screenshot_refusal_version: 1,
        capture_screenshot_refusal: refusal,
      });
    else {
      expect(context).not.toHaveProperty("capture_screenshot_refusal_version");
      expect(context).not.toHaveProperty("capture_screenshot_refusal");
    }
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([
  ...BROWSER_DAEMON_RESPONSE_VALIDATIONS.map(
    (validation, code) => [[1, code], validation] as const,
  ),
  [[1, 5], undefined],
  [[1, -1], undefined],
  [[1, 1.5], undefined],
  [[1, "1"], undefined],
  [[1, "invalid_json"], undefined],
  [[1, null], undefined],
  [[2, 1], undefined],
  [[0, 1], undefined],
  [[1, 1, 0], undefined],
  [[1], undefined],
  [[], undefined],
  [{ 0: 1, 1: 1, length: 2 }, undefined],
  ["PRIVATE", undefined],
  [1, undefined],
  [null, undefined],
] as const)(
  "exports only an exact version1 response tuple at exit5 (%j)",
  async (tuple, validation) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 5,
      stdout: JSON.stringify({ r1: tuple, private: "PRIVATE" }),
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
      capture_command_exit_code: 5,
      ...(validation && {
        capture_response_diagnostic_version: 1,
        capture_response_validation: validation,
      }),
    });
    expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
  },
);

it.each([
  ["stream_status", 2, false],
  ["stream_status", 3, false],
  ["stream_status", 4, false],
  ["stream_status", 6, false],
  ["stream_status", 1, false],
  ["fresh_screenshot", 2, false],
  ["fresh_screenshot", 6, false],
  ["fresh_screenshot", 5, true],
  ["frame_bridge", 5, false],
] as const)(
  "restricts the response tuple to daemon exit5 (%s exit%s)",
  async (stage, exitCode, eligible) => {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    const error = new CommandExitError({
      exitCode,
      stdout: JSON.stringify({ r1: [1, 3] }),
      stderr: "PRIVATE",
    });
    sandbox.commands.run.mockImplementation(
      sdkRun(async (command: string) => {
        if (
          stage === "fresh_screenshot"
            ? command.includes('"action":"screenshot"')
            : stage === "stream_status"
              ? command.includes('"action":"stream_status"')
              : !command.includes('"action":"stream_status"')
        )
          throw error;
        return run(command);
      }),
    );
    const observed = jest.fn();
    await expect(
      captureBrowserFrame(
        sandbox as unknown as Sandbox,
        location,
        "default",
        stage === "fresh_screenshot",
        undefined,
        observed,
      ),
    ).rejects.toBe(error);
    const context = observed.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_stage: stage,
      capture_command_exit_code: exitCode,
    });
    if (eligible)
      expect(context).toMatchObject({
        capture_response_diagnostic_version: 1,
        capture_response_validation: "success_false",
      });
    else {
      expect(context).not.toHaveProperty("capture_response_diagnostic_version");
      expect(context).not.toHaveProperty("capture_response_validation");
    }
  },
);

it.each([
  ["an older writer", JSON.stringify({ cv: [1, 0] })],
  ["empty output", ""],
  ["an oversized packet", JSON.stringify({ r1: [1, 2], pad: " ".repeat(544) })],
])(
  "leaves the response check unmeasured for %s at exit5",
  async (_case, stdout) => {
    const sandbox = fixture();
    const error = new CommandExitError({
      exitCode: 5,
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
    const context = observed.mock.calls[0][0];
    expect(context).toMatchObject({
      capture_stage: "stream_status",
      capture_error_kind: "command_exit",
      capture_command_exit_code: 5,
    });
    expect(context).not.toHaveProperty("capture_response_diagnostic_version");
    expect(context).not.toHaveProperty("capture_response_validation");
  },
);

it("keeps the original exit5 rejection when the observer throws on a response refusal", async () => {
  const { sandbox, thrown } = helperSandbox("fresh_screenshot", "null");
  const observed = jest.fn(() => {
    throw new Error("PRIVATE observer");
  });
  const failure = await captureBrowserFrame(
    sandbox as unknown as Sandbox,
    location,
    "default",
    true,
    undefined,
    observed,
  ).catch((error: unknown) => error);
  expect(failure).toBe(thrown[0]);
  expect(observed).toHaveBeenCalledTimes(1);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
});

describe("stream-status SDK start acknowledgement phase", () => {
  afterEach(() => jest.restoreAllMocks());

  const statusCommand = (requireFresh: boolean) =>
    browserDaemonCommand(
      location.directory,
      "default",
      requireFresh
        ? { action: "stream_status" }
        : { action: "stream_status", owned_port: true },
    );
  // The existing 7s command deadline; the 8s handshake stays inherited from connect.
  const backgroundStart = { user: "root", timeoutMs: 7_000, background: true };
  const failureBase = {
    capture_stage: "stream_status",
    capture_command_exit_code: "none",
  };

  /**
   * Model e2b `run` for the status command only: `start` yields the process
   * handle or rejects; a background run returns that handle, and a foreground
   * run awaits the same handle's wait, as the SDK does. Other commands use the
   * fixture.
   */
  function statusSandbox(start: () => Promise<ReturnType<typeof sdkHandle>>) {
    const sandbox = fixture();
    const run = sandbox.commands.run.getMockImplementation()!;
    sandbox.commands.run.mockImplementation(async (command, options) => {
      if (!command.includes('"action":"stream_status"'))
        return run(command, options);
      const handle = await start();
      return options?.background ? handle : handle.wait();
    });
    return sandbox;
  }

  /** Queue the two monotonic reads; each entry returns a value or throws. */
  function clock(...reads: (() => unknown)[]) {
    const now = jest.spyOn(performance, "now");
    for (const read of reads) now.mockImplementationOnce(read as () => number);
    return now;
  }

  const capture = (
    sandbox: ReturnType<typeof fixture>,
    requireFresh: boolean,
    observed: jest.Mock,
  ) =>
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      requireFresh,
      undefined,
      observed,
    ).catch((error: unknown) => error);

  it.each([
    [false, new TimeoutError("PRIVATE deadline_exceeded"), "timeout"],
    [true, new TimeoutError("PRIVATE canceled"), "timeout"],
    [
      false,
      new Error("PRIVATE https://private.invalid/?token=x"),
      "other_error",
    ],
    [false, "PRIVATE thrown value", "thrown_value"],
  ] as const)(
    "reports start when the SDK returns no handle (fresh: %s, %#)",
    async (requireFresh, error, kind) => {
      clock(
        () => 100,
        () => 200,
      );
      const sandbox = statusSandbox(async () => {
        throw error;
      });
      const observed = jest.fn();
      expect(await capture(sandbox, requireFresh, observed)).toBe(error);
      expect(observed.mock.calls).toEqual([
        [
          {
            ...failureBase,
            capture_error_kind: kind,
            capture_sdk_command_diagnostic_version: 1,
            capture_sdk_command_phase: "start",
          },
        ],
      ]);
      // One unchanged start request, only background added; no retry or extra call.
      expect(sandbox.commands.run.mock.calls).toEqual([
        [statusCommand(requireFresh), backgroundStart],
      ]);
      expect(JSON.stringify(observed.mock.calls)).not.toContain("PRIVATE");
    },
  );

  it.each([
    [0, "lt1s"],
    [999.9, "lt1s"],
    [1_000, "lt3s"],
    [2_999, "lt3s"],
    [3_000, "lt6s"],
    [5_999.5, "lt6s"],
    [6_000, "gte6s"],
    [7_950, "gte6s"],
  ] as const)(
    "reports wait with a closed %sms start-acknowledgement bucket",
    async (latency, bucket) => {
      clock(
        () => 5_000,
        () => 5_000 + latency,
      );
      const error = new TimeoutError("PRIVATE deadline_exceeded");
      const handle = sdkHandle(async () => {
        throw error;
      });
      const sandbox = statusSandbox(async () => handle);
      const observed = jest.fn();
      expect(await capture(sandbox, false, observed)).toBe(error);
      expect(observed.mock.calls).toEqual([
        [
          {
            ...failureBase,
            capture_error_kind: "timeout",
            capture_sdk_command_diagnostic_version: 1,
            capture_sdk_command_phase: "wait",
            capture_sdk_start_ack_latency: bucket,
          },
        ],
      ]);
      // Same handle, awaited once with no fresh timeout, signal or request.
      expect(handle.wait).toHaveBeenCalledTimes(1);
      expect(handle.wait).toHaveBeenCalledWith();
      expect(handle.kill).not.toHaveBeenCalled();
      expect(handle.disconnect).not.toHaveBeenCalled();
      expect(sandbox.commands.run.mock.calls).toEqual([
        [statusCommand(false), backgroundStart],
      ]);
    },
  );

  it.each([
    [
      "an unreadable start clock",
      () => {
        throw new Error("PRIVATE clock");
      },
      () => 1_000,
    ],
    [
      "an unreadable acknowledgement clock",
      () => 1_000,
      () => {
        throw new Error("PRIVATE clock");
      },
    ],
    ["a NaN acknowledgement", () => 1_000, () => NaN],
    ["an infinite acknowledgement", () => 1_000, () => Infinity],
    ["an infinite start", () => -Infinity, () => 1_000],
    ["a backwards clock", () => 2_000, () => 1_999],
    ["a non-number reading", () => 1_000, () => "2000"],
    ["a missing reading", () => 1_000, () => undefined],
  ])(
    "omits the whole wait group for %s while preserving the rejection",
    async (_case, startRead, ackRead) => {
      clock(startRead, ackRead);
      const error = new TimeoutError("PRIVATE deadline_exceeded");
      const handle = sdkHandle(async () => {
        throw error;
      });
      const sandbox = statusSandbox(async () => handle);
      const observed = jest.fn();
      expect(await capture(sandbox, false, observed)).toBe(error);
      expect(observed.mock.calls).toEqual([
        [{ ...failureBase, capture_error_kind: "timeout" }],
      ]);
      expect(handle.wait).toHaveBeenCalledTimes(1);
      expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps a start phase without reading any acknowledgement time", async () => {
    clock(() => {
      throw new Error("PRIVATE clock");
    });
    const error = new TimeoutError("PRIVATE");
    const sandbox = statusSandbox(async () => {
      throw error;
    });
    const observed = jest.fn();
    expect(await capture(sandbox, false, observed)).toBe(error);
    expect(observed.mock.calls[0][0]).toEqual({
      ...failureBase,
      capture_error_kind: "timeout",
      capture_sdk_command_diagnostic_version: 1,
      capture_sdk_command_phase: "start",
    });
  });

  it("captures unchanged through one background start and its wait", async () => {
    clock(
      () => {
        throw new Error("PRIVATE clock");
      },
      () => NaN,
    );
    const handle = sdkHandle(async () => ({
      exitCode: 0,
      stdout: JSON.stringify({ data: { port: 1234 } }),
    }));
    const sandbox = statusSandbox(async () => handle);
    const observed = jest.fn();
    const result = await captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      false,
      undefined,
      observed,
    );
    expect(result).toEqual({
      image: `data:image/jpeg;base64,${cached.toString("base64")}`,
      width: 800,
      height: 600,
      capturedAt: 0,
      browserSessionName: "default",
    });
    expect(observed).not.toHaveBeenCalled();
    expect(handle.wait).toHaveBeenCalledTimes(1);
    expect(sandbox.commands.run.mock.calls).toEqual([
      [statusCommand(false), backgroundStart],
      [browserBridgeCommand(1234, "frame"), { user: "root", timeoutMs: 8_000 }],
    ]);
  });

  it("keeps a waited command exit's existing context without a phase group", async () => {
    clock(
      () => 0,
      () => 10,
    );
    const error = new CommandExitError({
      exitCode: 3,
      stdout: JSON.stringify({ deadline: [1, "awaiting_response"] }),
      stderr: "PRIVATE",
    });
    const handle = sdkHandle(async () => {
      throw error;
    });
    const sandbox = statusSandbox(async () => handle);
    const observed = jest.fn();
    expect(await capture(sandbox, false, observed)).toBe(error);
    expect(observed.mock.calls).toEqual([
      [
        {
          capture_stage: "stream_status",
          capture_error_kind: "command_exit",
          capture_command_exit_code: 3,
          capture_deadline_diagnostic_version: 1,
          capture_deadline_phase: "awaiting_response",
        },
      ],
    ]);
  });

  it("adds no phase to a returned nonzero exit that the SDK did not reject", async () => {
    clock(
      () => 0,
      () => 10,
    );
    const sandbox = statusSandbox(async () =>
      sdkHandle(async () => ({ exitCode: 2, stdout: "PRIVATE" })),
    );
    const observed = jest.fn();
    expect(await capture(sandbox, false, observed)).toEqual(
      new BrowserPreviewUnavailable("closed"),
    );
    expect(observed.mock.calls).toEqual([
      [{ ...failureBase, capture_error_kind: "preview_unavailable" }],
    ]);
  });

  it("keeps the original wait rejection when the observer throws", async () => {
    clock(
      () => 0,
      () => 10,
    );
    const error = new TimeoutError("PRIVATE");
    const handle = sdkHandle(async () => {
      throw error;
    });
    const sandbox = statusSandbox(async () => handle);
    const observed = jest.fn(() => {
      throw new Error("PRIVATE observer");
    });
    expect(await capture(sandbox, false, observed)).toBe(error);
    expect(observed).toHaveBeenCalledTimes(1);
    expect(handle.wait).toHaveBeenCalledTimes(1);
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  });

  it("keeps non-capture stream-port lookups on the original foreground run", async () => {
    const now = jest.spyOn(performance, "now");
    const sandbox = fixture();
    await expect(
      getPrivateStreamPort(sandbox as unknown as Sandbox, location, "default"),
    ).resolves.toBe(1234);
    expect(sandbox.commands.run.mock.calls).toEqual([
      [statusCommand(true), { user: "root", timeoutMs: 7_000 }],
    ]);
    expect(now).not.toHaveBeenCalled();
  });
});

const completedSelectedWrapper = {
  ...startedSelectedWrapper,
  wrapper_action: "other",
  wrapper_phase: "completed",
  wrapper_exit: 0,
};

it.each<[number[], string, string]>([
  [[1, 0, 0], "exit_zero", "lt1s"],
  [[1, 1, 3], "exit_nonzero", "lt60s"],
  [[1, 2, 5], "signal", "older"],
  [[1, 3, 1], "verification_gate", "lt10s"],
])(
  "projects the selected wrapper result %j with its latest or previous scope",
  async (l1, result, elapsed) => {
    for (const [wrapper, scope] of [
      [startedSelectedWrapper, "previous_wrapper"],
      [completedSelectedWrapper, "latest_wrapper"],
    ] as const) {
      const context = await observeDaemonFailure(
        3,
        JSON.stringify({
          deadline: [1, "awaiting_response"],
          ...wrapper,
          l1,
          private: "PRIVATE",
        }),
      );
      expect(context).toMatchObject({
        capture_stage: "stream_status",
        capture_command_exit_code: 3,
        capture_deadline_phase: "awaiting_response",
        capture_wrapper_phase: wrapper.wrapper_phase,
        capture_wrapper_result_version: 1,
        capture_wrapper_result_scope: scope,
        capture_wrapper_result: result,
        capture_wrapper_result_elapsed: elapsed,
      });
      expect(JSON.stringify(context)).not.toContain("PRIVATE");
    }
  },
);

const wrapperResultFields = [
  "capture_wrapper_result_version",
  "capture_wrapper_result_scope",
  "capture_wrapper_result",
  "capture_wrapper_result_elapsed",
];

it.each([
  [[1, 4, 0]],
  [[1, 0, 6]],
  [[1, -1, 0]],
  [[2, 0, 0]],
  [[1, 0.5, 0]],
  [[1, "0", 0]],
  [[1, true, 0]],
  [[1, 0]],
  [[1, 0, 0, 0]],
  [{ 0: 1, 1: 0, 2: 0, length: 3 }],
  ["PRIVATE"],
  [null],
  [undefined], // An older helper or writer, or dropped at the cap.
])("omits the whole wrapper result group for %j", async (l1) => {
  const context = await observeDaemonFailure(
    3,
    JSON.stringify({
      deadline: [1, "awaiting_response"],
      ...startedSelectedWrapper,
      l1,
    }),
  );
  expect(context.capture_wrapper_phase).toBe("started");
  for (const field of wrapperResultFields)
    expect(context).not.toHaveProperty(field);
});

it.each([
  { wrapper_session_matches: false },
  { wrapper_receipt_version: 2 },
  { wrapper_age: "PRIVATE" },
  { wrapper_receipt_version: undefined },
])(
  "never attributes a wrapper result without a valid selected-session receipt: %j",
  async (override) => {
    const context = await observeDaemonFailure(
      2,
      JSON.stringify({
        diagnostic_reason: "socket_stat",
        diagnostic_error: "missing",
        ...startedSelectedWrapper,
        ...override,
        l1: [1, 1, 3],
      }),
    );
    expect(context.capture_precondition_reason).toBe("socket_stat");
    for (const field of wrapperResultFields)
      expect(context).not.toHaveProperty(field);
  },
);

it("projects the wrapper result at a fresh screenshot deadline and keeps its rejection", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const error = new CommandExitError({
    exitCode: 3,
    stderr: "PRIVATE",
    stdout: JSON.stringify({
      deadline: [1, "awaiting_response"],
      ...startedSelectedWrapper,
      l1: [1, 0, 2],
    }),
  });
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    }),
  );
  const observe = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
    ),
  ).rejects.toBe(error);
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  expect(observe.mock.calls[0][0]).toMatchObject({
    capture_stage: "fresh_screenshot",
    capture_wrapper_result_scope: "previous_wrapper",
    capture_wrapper_result: "exit_zero",
    capture_wrapper_result_elapsed: "lt30s",
  });
});

it("parses the wrapper result beside every existing field in a packet at the unchanged cap", async () => {
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
    k1: 6,
    l1: [1, 1, 3],
    dv: [1, 1, 39003],
    cv: [1, 2],
  });
  expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(544);
  const context = await observeDaemonFailure(
    3,
    packet + " ".repeat(544 - packet.length),
  );
  expect(context).toMatchObject({
    capture_deadline_phase: "awaiting_response",
    capture_wrapper_process_visibility: "same_incarnation_visible",
    capture_wrapper_command_class: "other",
    capture_wrapper_result_scope: "previous_wrapper",
    capture_wrapper_result: "exit_nonzero",
    capture_wrapper_result_elapsed: "lt60s",
    capture_open_socket_return_status: "owned_socket",
    capture_daemon_version_file_status: "measured",
  });
});

/** A connected status deadline after the selected session's successful OPEN. */
const queuePacket = (override: Record<string, unknown> = {}) =>
  JSON.stringify({
    deadline: [1, "awaiting_response"],
    ...completedSelectedWrapper,
    ...successfulSelectedOpen,
    q1: [1, 2, 3],
    private: "PRIVATE",
    ...override,
  });
const queueGroup = (context: Record<string, unknown>) => ({
  version: context.capture_daemon_socket_queue_version,
  pending: context.capture_daemon_socket_pending_count,
  held: context.capture_daemon_socket_held_count,
});

it.each<[string, number, number[] | null, Record<string, unknown>]>([
  ["distinct counts", 3, [2, 3], {}],
  ["zero counts", 3, [0, 0], { q1: [1, 0, 0] }],
  ["saturated counts", 3, [15, 15], { q1: [1, 15, 15] }],
  ["no tuple", 3, null, { q1: undefined }], // Older helper, unverified or dropped.
  ["another version", 3, null, { q1: [2, 2, 3] }],
  ["a short tuple", 3, null, { q1: [1, 2] }],
  ["a long tuple", 3, null, { q1: [1, 2, 3, 0] }],
  ["a count over 15", 3, null, { q1: [1, 16, 3] }],
  ["a negative count", 3, null, { q1: [1, 2, -1] }],
  ["a fractional count", 3, null, { q1: [1, 1.5, 3] }],
  ["a string count", 3, null, { q1: [1, "2", 3] }],
  ["an array-like tuple", 3, null, { q1: { 0: 1, 1: 2, 2: 3, length: 3 } }],
  ["a connecting deadline", 3, null, { deadline: [1, "connecting"] }],
  ["a daemon close", 6, null, {}],
  ["another session's OPEN", 3, null, { open_session_matches: false }],
  ["a failed OPEN", 3, null, { open_exit: 1 }],
])(
  "projects the listener queue only from a strict tuple at the connected deadline: %s",
  async (_case, exitCode, counts, override) => {
    const context = await observeDaemonFailure(exitCode, queuePacket(override));
    expect(context).toMatchObject({
      capture_stage: "stream_status",
      capture_command_exit_code: exitCode,
      capture_wrapper_phase: "completed",
    });
    expect(queueGroup(context)).toEqual(
      counts ? { version: 1, pending: counts[0], held: counts[1] } : {},
    );
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
  },
);

/** The selected OPEN still STARTED at the deadline, with its exact wrapper visible. */
const runningOpenPacket = (override: Record<string, unknown> = {}) =>
  queuePacket({
    ...startedSelectedWrapper,
    open_phase: "started",
    open_exit: "none",
    w1: 3,
    ...override,
  });

it.each<[string, number, number[] | null, Record<string, unknown>]>([
  ["its exact wrapper incarnation visible", 3, [2, 3], {}],
  ["no tuple", 3, null, { q1: undefined }],
  ["a malformed tuple", 3, null, { q1: [1, 16, 3] }],
  ["unmeasured wrapper visibility", 3, null, { w1: undefined }],
  ["a changed wrapper incarnation", 3, null, { w1: 2 }],
  ["a zombie wrapper", 3, null, { w1: 4 }],
  ["a latest wrapper of another command", 3, null, { wrapper_action: "other" }],
  [
    "a completed latest wrapper",
    3,
    null,
    { wrapper_phase: "completed", wrapper_exit: 0 },
  ],
  ["another session's wrapper", 3, null, { wrapper_session_matches: false }],
  ["another session's OPEN", 3, null, { open_session_matches: false }],
  ["a started OPEN with an exit", 3, null, { open_exit: 0 }],
  ["a connecting deadline", 3, null, { deadline: [1, "connecting"] }],
  ["a daemon close", 6, null, {}],
])(
  "projects the queue beside a still-running selected OPEN only when scoped: %s",
  async (_case, exitCode, counts, override) => {
    const context = await observeDaemonFailure(
      exitCode,
      runningOpenPacket(override),
    );
    expect(queueGroup(context)).toEqual(
      counts ? { version: 1, pending: counts[0], held: counts[1] } : {},
    );
    expect(JSON.stringify(context)).not.toContain("PRIVATE");
    if (!counts) return;
    // The same existing context, plus only the queue group.
    const {
      capture_daemon_socket_queue_version: _version,
      capture_daemon_socket_pending_count: _pending,
      capture_daemon_socket_held_count: _held,
      ...rest
    } = context;
    expect(rest).toEqual(
      await observeDaemonFailure(3, runningOpenPacket({ q1: undefined })),
    );
    expect(rest).toMatchObject({
      capture_open_phase: "started",
      capture_wrapper_action: "open",
      capture_wrapper_process_visibility: "same_incarnation_visible",
    });
  },
);

it("projects the queue at a fresh screenshot deadline and keeps its rejection and cleanup", async () => {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const error = new CommandExitError({
    exitCode: 3,
    stderr: "PRIVATE",
    stdout: queuePacket({ q1: [1, 0, 1] }),
  });
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    }),
  );
  const observe = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
    ),
  ).rejects.toBe(error);
  // No added request or retry; the screenshot file is still removed.
  expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  const context = observe.mock.calls[0][0];
  expect(context.capture_stage).toBe("fresh_screenshot");
  expect(queueGroup(context)).toEqual({ version: 1, pending: 0, held: 1 });
});

/** The GET's fresh screenshot rejects with this packet; the same request, rejection and cleanup. */
async function observeScreenshotFailure(packet: string) {
  const sandbox = fixture();
  const run = sandbox.commands.run.getMockImplementation()!;
  const error = new CommandExitError({
    exitCode: 3,
    stderr: "PRIVATE",
    stdout: packet,
  });
  sandbox.commands.run.mockImplementation(
    sdkRun(async (command: string) => {
      if (command.includes('"action":"screenshot"')) throw error;
      return run(command);
    }),
  );
  const observe = jest.fn();
  await expect(
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observe,
      { recognizeClosed: true },
    ),
  ).rejects.toBe(error);
  expect(sandbox.commands.run).toHaveBeenCalledTimes(3);
  expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  expect(observe).toHaveBeenCalledTimes(1);
  return observe.mock.calls[0][0];
}

it.each<[number, string]>([
  [1, "before_write"],
  [2, "after_write"],
])(
  "adds only the closed write order %i beside a still-running OPEN's screenshot queue",
  async (ot1, order) => {
    const context = await observeScreenshotFailure(runningOpenPacket({ ot1 }));
    const { capture_open_start_write_order_v1: projected, ...rest } = context;
    expect(projected).toBe(order);
    expect(rest).toEqual(await observeScreenshotFailure(runningOpenPacket()));
    expect(rest).toMatchObject({
      capture_stage: "fresh_screenshot",
      capture_command_exit_code: 3,
      capture_deadline_phase: "awaiting_response",
      capture_open_phase: "started",
      capture_daemon_socket_held_count: 3,
    });
  },
);

it.each<[string, () => Promise<Record<string, unknown>>]>([
  ["no code", () => observeScreenshotFailure(runningOpenPacket())],
  ...[0, 3, "1", 1.5, [1], null].map(
    (ot1) =>
      [
        `the malformed code ${JSON.stringify(ot1)}`,
        () => observeScreenshotFailure(runningOpenPacket({ ot1 })),
      ] as [string, () => Promise<Record<string, unknown>>],
  ),
  [
    "no verified queue",
    () =>
      observeScreenshotFailure(runningOpenPacket({ ot1: 1, q1: undefined })),
  ],
  [
    "a completed OPEN's queue",
    () => observeScreenshotFailure(queuePacket({ ot1: 1 })),
  ],
  [
    "a status failure",
    () => observeDaemonFailure(3, runningOpenPacket({ ot1: 1 })),
  ],
])("omits the write order for %s", async (_case, observe) => {
  const context = await observe();
  expect(context).not.toHaveProperty("capture_open_start_write_order_v1");
  expect(context.capture_deadline_phase).toBe("awaiting_response");
});

it.each([544, 545])(
  "keeps the unchanged parser cap for a %s-byte packet carrying the queue",
  async (bytes) => {
    const packet = queuePacket();
    const context = await observeDaemonFailure(
      3,
      packet + " ".repeat(bytes - packet.length),
    );
    expect(queueGroup(context)).toEqual(
      bytes === 544 ? { version: 1, pending: 2, held: 3 } : {},
    );
  },
);

describe("fresh screenshot read phase", () => {
  const failure = (stage: string, kind: string, group = {}) => [
    [
      {
        capture_stage: stage,
        capture_error_kind: kind,
        capture_command_exit_code: "none",
        ...group,
      },
    ],
  ];
  const capture = (sandbox: ReturnType<typeof fixture>, observed: jest.Mock) =>
    captureBrowserFrame(
      sandbox as unknown as Sandbox,
      location,
      "default",
      true,
      undefined,
      observed,
    );
  const sdkNotFound = () =>
    Object.assign(new Error("PRIVATE /dev/shm/preview.jpg"), {
      name: "NotFoundError",
      statusCode: 404,
    });
  // Buffer.from reads valueOf; this incompatible result's conversion rejects.
  const unconvertible = (error: unknown) =>
    ({
      PRIVATE_BYTES: "PRIVATE_CONTENT",
      valueOf: () => {
        throw error;
      },
    }) as never;

  it.each([
    [
      "sdk_read",
      (sandbox: ReturnType<typeof fixture>, error: Error) =>
        sandbox.files.read.mockRejectedValueOnce(error),
      sdkNotFound(),
      {
        capture_fresh_read_error_kind: "not_found",
        capture_fresh_read_http_status: 404,
      },
    ],
    [
      "bytes_convert",
      (sandbox: ReturnType<typeof fixture>, error: Error) =>
        sandbox.files.read.mockResolvedValueOnce(unconvertible(error)),
      new Error("PRIVATE conversion"),
      {},
    ],
  ] as const)(
    "attributes the %s phase and keeps its rejection through cleanup",
    async (phase, arrange, error, sdk) => {
      const sandbox = fixture();
      arrange(sandbox, error);
      // An asynchronous cleanup rejection stays swallowed.
      sandbox.files.remove.mockRejectedValueOnce(new Error("PRIVATE cleanup"));
      const observed = jest.fn();
      await expect(capture(sandbox, observed)).rejects.toBe(error);
      expect(observed.mock.calls).toEqual(
        failure("fresh_read", "other_error", {
          capture_fresh_read_diagnostic_version: 1,
          capture_fresh_read_phase: phase,
          ...sdk,
        }),
      );
      expect(JSON.stringify(observed.mock.calls)).not.toMatch(
        /PRIVATE|\/dev\/shm/,
      );
      const [[path, options]] = sandbox.files.read.mock.calls as unknown as [
        [string, unknown],
      ];
      expect(options).toEqual({
        format: "bytes",
        user: "root",
        requestTimeoutMs: 4_000,
      });
      expect(sandbox.files.remove.mock.calls).toEqual([
        [path, { user: "root", requestTimeoutMs: 4_000 }],
      ]);
    },
  );

  const readError = sdkNotFound();
  const cleanupError = new Error("PRIVATE cleanup");
  it.each([
    ["an SDK read rejection", readError, cleanupError],
    ["the same SDK read rejection thrown again", readError, readError],
    ["a conversion rejection", unconvertible(readError), cleanupError],
  ])(
    "does not attribute a synchronous cleanup exception replacing %s",
    async (_case, readOutcome: unknown, thrown) => {
      const sandbox = fixture();
      if (readOutcome instanceof Error)
        sandbox.files.read.mockRejectedValueOnce(readOutcome);
      else sandbox.files.read.mockResolvedValueOnce(readOutcome as never);
      sandbox.files.remove.mockImplementationOnce(() => {
        throw thrown;
      });
      const observed = jest.fn();
      // The existing finally lets this cleanup exception replace the failure.
      await expect(capture(sandbox, observed)).rejects.toBe(thrown);
      expect(observed.mock.calls).toEqual(failure("fresh_read", "other_error"));
    },
  );

  it("omits the group once validation follows a successful conversion", async () => {
    const sandbox = fixture();
    sandbox.files.read.mockResolvedValueOnce(Buffer.from([0x89, 0x50, 0, 0]));
    const observed = jest.fn();
    await expect(capture(sandbox, observed)).rejects.toThrow(
      "Browser preview disconnected",
    );
    expect(observed.mock.calls).toEqual(
      failure("fresh_validation", "preview_unavailable"),
    );
    expect(sandbox.files.remove).toHaveBeenCalledTimes(1);
  });
});

it.each([false, true])(
  "projects a gate deadline from the exact failed pause command (SDK throws: %s)",
  async (fromSdk) => {
    const sandbox = fixture();
    const result = {
      exitCode: 1,
      stdout: "PRIVATE_OUTPUT",
      stderr: "PRIVATE_TRACEBACK\nRuntimeError: Browser command is busy\n",
    };
    const error = new CommandExitError(result);
    if (fromSdk) sandbox.commands.run.mockRejectedValueOnce(error);
    else sandbox.commands.run.mockResolvedValueOnce(result);
    const caught = await setAgentBrowserPaused(
      sandbox as unknown as Sandbox,
      location,
      true,
    ).catch((failure: unknown) => failure);
    if (fromSdk) expect(caught).toBe(error);
    else expect(caught).toBeInstanceOf(BrowserPreviewUnavailable);
    expect(browserPauseFailureContext(caught)).toEqual({
      pause_diagnostic_version: 1,
      pause_error_kind: "gate_busy",
      pause_command_exit_code: 1,
      pause_http_status: "none",
    });
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
  },
);

it("requires the fixed pause exception line and preserves the SDK timeout classification", () => {
  const unrelated = new CommandExitError({
    exitCode: 1,
    stdout: "PRIVATE_OUTPUT",
    stderr: "PRIVATE_TEXT RuntimeError: Browser command is busy\n",
  });
  expect(browserPauseFailureContext(unrelated)).toEqual({
    pause_diagnostic_version: 1,
    pause_error_kind: "command_exit",
    pause_command_exit_code: 1,
    pause_http_status: "none",
  });
  expect(browserPauseFailureContext(new TimeoutError("PRIVATE SDK"))).toEqual({
    pause_diagnostic_version: 1,
    pause_error_kind: "timeout",
    pause_command_exit_code: "none",
    pause_http_status: "none",
  });
});
