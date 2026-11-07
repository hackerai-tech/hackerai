import { captureBrowserFrame, resizeBrowserViewport } from "../server";
import { CommandExitError } from "@e2b/code-interpreter";
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
