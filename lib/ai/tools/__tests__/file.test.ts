jest.mock("../utils/sandbox-file-uploader", () => ({
  uploadSandboxFileToConvex: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

jest.mock("@/lib/logger", () => ({
  logger: { error: jest.fn() },
}));

import { createFile } from "../file";
import type { ToolContext } from "@/types";

type FakeCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

function makeContext(sandbox: unknown): ToolContext {
  return {
    sandboxManager: {
      getSandbox: jest.fn(async () => ({ sandbox })),
      setSandbox: jest.fn(),
      getSandboxType: jest.fn(),
      getSandboxInfo: jest.fn(() => null),
      getEffectivePreference: jest.fn(() => "e2b"),
      recordHealthFailure: jest.fn(() => false),
      resetHealthFailures: jest.fn(),
      isSandboxUnavailable: jest.fn(() => false),
    },
    writer: { write: jest.fn() } as never,
    userLocation: {} as never,
    todoManager: {} as never,
    userID: "user-1",
    chatId: "chat-1",
    fileAccumulator: {} as never,
    backgroundProcessTracker: {} as never,
    ptySessionManager: {} as never,
    mode: "agent",
    modelName: "openai/gpt-5",
    subscription: "pro",
    isE2BSandbox: (() => true) as never,
    caidoEnabled: false,
  };
}

async function runTool(
  tool: ReturnType<typeof createFile>,
  input: Record<string, unknown>,
) {
  const execute = (
    tool as unknown as {
      execute: (i: unknown, o: unknown) => Promise<unknown>;
    }
  ).execute;
  return execute(input, {
    toolCallId: "call-1",
    abortSignal: undefined,
    messages: [],
  });
}

function makeSandbox(
  commandRun: jest.Mock<Promise<FakeCommandResult>, [string, any?]>,
) {
  return {
    commands: { run: commandRun },
    files: {
      read: jest.fn(async () => {
        throw new Error("files.read should not be called");
      }),
      write: jest.fn(async () => undefined),
      remove: jest.fn(),
      list: jest.fn(),
    },
  };
}

describe("file tool large text safety", () => {
  test("does not load oversized files for full reads", async () => {
    const commandRun = jest.fn(async () => ({
      stdout: JSON.stringify({
        path: "/tmp/download.php",
        sizeBytes: 5_000_000,
        totalLines: 2_216_265,
        tooLarge: true,
      }),
      stderr: "",
      exitCode: 0,
    }));
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "read",
      path: "/tmp/download.php",
      brief: "Read a large file",
    })) as { content: string };

    expect(result.content).toContain("too large to read in full");
    expect(result.content).toContain("range [1, 200]");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  test("reads ranges through the bounded sandbox-side path", async () => {
    const commandRun = jest.fn(async (_command, opts) => {
      expect(opts.envVars.HACKERAI_FILE_READ_RANGE_START).toBe("500");
      expect(opts.envVars.HACKERAI_FILE_READ_RANGE_END).toBe("501");
      return {
        stdout: JSON.stringify({
          path: "/tmp/download.php",
          sizeBytes: 5_000_000,
          totalLines: 2_216_265,
          content: "line 500\nline 501\n",
          startLine: 500,
          truncated: false,
        }),
        stderr: "",
        exitCode: 0,
      };
    });
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "read",
      path: "/tmp/download.php",
      brief: "Read a range",
      range: [500, 501],
    })) as { content: string };

    expect(result.content).toContain("   500|line 500");
    expect(result.content).toContain("   501|line 501");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  test("refuses edit on oversized files before reading them", async () => {
    const commandRun = jest.fn(async () => ({
      stdout: "5000000\n",
      stderr: "",
      exitCode: 0,
    }));
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "edit",
      path: "/tmp/download.php",
      brief: "Patch a huge file",
      edits: [{ find: "old", replace: "new" }],
    })) as { error: string };

    expect(result.error).toContain("too large for the edit action");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  test("appends to oversized files without reading existing content", async () => {
    const commandRun = jest
      .fn<Promise<FakeCommandResult>, [string, any?]>()
      .mockResolvedValueOnce({
        stdout: "5000000\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "",
        exitCode: 0,
      });
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "append",
      path: "/tmp/download.php",
      brief: "Append safely",
      text: "\nnew line\n",
    })) as { content: string };

    expect(result.content).toContain("full diff preview was skipped");
    expect(sandbox.files.write).toHaveBeenCalledWith(
      expect.stringContaining("/tmp/hackerai_append_"),
      "\nnew line\n",
      { user: "user" },
    );
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });
});
