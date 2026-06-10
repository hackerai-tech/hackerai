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
import { uploadSandboxFileToConvex } from "../utils/sandbox-file-uploader";
import type { ToolContext } from "@/types";

type FakeCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

const mockUploadSandboxFileToConvex =
  uploadSandboxFileToConvex as jest.MockedFunction<
    typeof uploadSandboxFileToConvex
  >;

function makeContext(
  sandbox: unknown,
  overrides: Partial<ToolContext> = {},
): ToolContext {
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
    ...overrides,
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

async function runToModelOutput(
  tool: ReturnType<typeof createFile>,
  output: unknown,
) {
  const toModelOutput = (
    tool as unknown as {
      toModelOutput: (i: { output: unknown }) => Promise<unknown>;
    }
  ).toModelOutput;
  return toModelOutput({ output });
}

function makeSandbox(
  commandRun: jest.Mock<Promise<FakeCommandResult>, [string, any?]>,
  opts?: { windows?: boolean },
) {
  return {
    ...(opts?.windows
      ? {
          sandboxKind: "centrifugo" as const,
          isWindows: () => true,
        }
      : {}),
    commands: { run: commandRun },
    files: {
      read: jest.fn(async () => {
        throw new Error("files.read should not be called");
      }),
      write: jest.fn(async () => undefined),
      remove: jest.fn(async () => undefined),
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
      stdout: JSON.stringify({
        kind: "file",
        path: "/tmp/download.php",
        sizeBytes: 5_000_000,
      }),
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
        stdout: JSON.stringify({
          kind: "file",
          path: "/tmp/download.php",
          sizeBytes: 5_000_000,
        }),
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

  test("fails closed when file size cannot be determined", async () => {
    const commandRun = jest
      .fn<Promise<FakeCommandResult>, [string, any?]>()
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "python missing",
        exitCode: 1,
      })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "python missing",
        exitCode: 1,
      });
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "read",
      path: "/tmp/download.php",
      brief: "Read when size probe fails",
    })) as { error: string };

    expect(result.error).toContain("Unable to determine file size");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  test("uses a Windows-compatible Python script path for bounded reads", async () => {
    const commandRun = jest
      .fn<Promise<FakeCommandResult>, [string, any?]>()
      .mockResolvedValueOnce({
        stdout: "$BASH_VERSION\r\n",
        stderr: "",
        exitCode: 0,
      })
      .mockImplementationOnce(async (command, opts) => {
        expect(command).toMatch(/^python "C:\\temp\\hackerai_script_/);
        expect(command).not.toContain("<<'PY'");
        expect(opts.envVars.HACKERAI_FILE_READ_PATH).toBe(
          "C:\\temp\\download.php",
        );
        return {
          stdout: JSON.stringify({
            path: "C:\\temp\\download.php",
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
    const sandbox = makeSandbox(commandRun, { windows: true });
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "read",
      path: "/tmp/download.php",
      brief: "Read a range on Windows",
      range: [500, 501],
    })) as { content: string };

    expect(result.content).toContain("   500|line 500");
    expect(result.content).toContain("   501|line 501");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  test("oversized append on Windows does not use POSIX cat/rm commands", async () => {
    const commandRun = jest
      .fn<Promise<FakeCommandResult>, [string, any?]>()
      .mockResolvedValueOnce({
        stdout: "$BASH_VERSION\r\n",
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: JSON.stringify({
          kind: "file",
          path: "C:\\temp\\download.php",
          sizeBytes: 5_000_000,
        }),
        stderr: "",
        exitCode: 0,
      })
      .mockResolvedValueOnce({
        stdout: "$BASH_VERSION\r\n",
        stderr: "",
        exitCode: 0,
      })
      .mockImplementationOnce(async (command, opts) => {
        expect(command).toMatch(/^python "C:\\temp\\hackerai_script_/);
        expect(command).not.toContain("cat ");
        expect(command).not.toContain("rm -f");
        expect(opts.envVars.HACKERAI_FILE_APPEND_TARGET_PATH).toBe(
          "C:\\temp\\download.php",
        );
        expect(opts.envVars.HACKERAI_FILE_APPEND_SOURCE_PATH).toMatch(
          /^C:\\temp\\hackerai_append_/,
        );
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
        };
      });
    const sandbox = makeSandbox(commandRun, { windows: true });
    const tool = createFile(makeContext(sandbox));

    const result = (await runTool(tool, {
      action: "append",
      path: "/tmp/download.php",
      brief: "Append safely on Windows",
      text: "\nnew line\n",
    })) as { content: string };

    expect(result.content).toContain("full diff preview was skipped");
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });
});

describe("file tool image view", () => {
  beforeEach(() => {
    mockUploadSandboxFileToConvex.mockReset();
  });

  test("allows Kimi to view sandbox images as multimodal tool output", async () => {
    mockUploadSandboxFileToConvex.mockResolvedValue({
      fileId: "file-1" as never,
      name: "screenshot.png",
      mediaType: "image/png",
    });

    const commandRun = jest
      .fn<Promise<FakeCommandResult>, [string, any?]>()
      .mockImplementationOnce(async (_command, opts) => {
        expect(opts.envVars.HACKERAI_FILE_VIEW_INCLUDE_DATA).toBe("0");
        return {
          stdout: JSON.stringify({
            path: "/tmp/screenshot.png",
            mediaType: "image/png",
            sizeBytes: 68,
            kind: "image",
          }),
          stderr: "",
          exitCode: 0,
        };
      })
      .mockImplementationOnce(async (_command, opts) => {
        expect(opts.envVars.HACKERAI_FILE_VIEW_INCLUDE_DATA).toBe("1");
        return {
          stdout: JSON.stringify({
            path: "/tmp/screenshot.png",
            mediaType: "image/png",
            sizeBytes: 68,
            kind: "image",
            data: "iVBORw0KGgo=",
          }),
          stderr: "",
          exitCode: 0,
        };
      });
    const sandbox = makeSandbox(commandRun);
    const tool = createFile(
      makeContext(sandbox, { modelName: "model-kimi-k2.6" }),
    );

    const result = await runTool(tool, {
      action: "view",
      path: "/tmp/screenshot.png",
      brief: "Inspect the screenshot",
    });
    expect(result).toMatchObject({
      action: "view",
      mediaType: "image/png",
      kind: "image",
    });

    await expect(runToModelOutput(tool, result)).resolves.toEqual({
      type: "content",
      value: [
        {
          type: "text",
          text: "Viewing image file: screenshot.png (image/png, 68 bytes).",
        },
        {
          type: "image-data",
          data: "iVBORw0KGgo=",
          mediaType: "image/png",
        },
      ],
    });
  });
});
