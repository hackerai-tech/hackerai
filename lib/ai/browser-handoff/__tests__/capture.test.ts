import {
  browserSessionReadFailureContext,
  browserRelayRenewFailureContext,
  captureBrowserFrame,
  getActiveBrowserSessionName,
  resizeBrowserViewport,
} from "../server";
import { CommandExitError, TimeoutError } from "@e2b/code-interpreter";
import type { Sandbox } from "@e2b/code-interpreter";

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
      relay_renew_diagnostic_version: 1,
      relay_renew_error_kind: kind,
      relay_renew_command_exit_code: exitCode,
    });
    expect(JSON.stringify(fields)).not.toContain("PRIVATE");
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
      relay_renew_diagnostic_version: 1,
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
