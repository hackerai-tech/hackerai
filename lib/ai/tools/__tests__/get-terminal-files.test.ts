jest.mock("../utils/sandbox-file-uploader", () => ({
  uploadSandboxFileToConvex: jest.fn(),
}));

import { createGetTerminalFiles } from "../get-terminal-files";
import { uploadSandboxFileToConvex } from "../utils/sandbox-file-uploader";
import type { ToolContext } from "@/types";

const mockUploadSandboxFileToConvex =
  uploadSandboxFileToConvex as jest.MockedFunction<
    typeof uploadSandboxFileToConvex
  >;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sandboxManager: {
      getSandbox: jest.fn(async () => ({ sandbox: { id: "sandbox-1" } })),
      setSandbox: jest.fn(),
      getSandboxType: jest.fn(),
      getSandboxInfo: jest.fn(() => null),
      getEffectivePreference: jest.fn(() => "e2b"),
      recordHealthFailure: jest.fn(() => false),
      resetHealthFailures: jest.fn(),
      isSandboxUnavailable: jest.fn(() => false),
    },
    backgroundProcessTracker: {
      hasActiveProcessesForFiles: jest.fn(async () => ({
        active: false,
        processes: [],
      })),
    },
    fileAccumulator: {
      add: jest.fn(),
      getAll: jest.fn(() => []),
      clear: jest.fn(),
    },
    writer: { write: jest.fn() } as never,
    userLocation: {} as never,
    todoManager: {} as never,
    userID: "user-1",
    chatId: "chat-1",
    assistantMessageId: "assistant-1",
    ptySessionManager: {} as never,
    mode: "agent",
    modelName: "model-grok-4.5",
    subscription: "pro",
    isE2BSandbox: (() => true) as never,
    ...overrides,
  } as ToolContext;
}

async function runTool(
  tool: ReturnType<typeof createGetTerminalFiles>,
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

describe("get_terminal_files", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("blocks file delivery when a selected local sandbox falls back", async () => {
    const writerWrites: unknown[] = [];
    const context = makeContext({
      sandboxManager: {
        getSandbox: jest.fn(async () => ({ sandbox: { id: "cloud" } })),
        setSandbox: jest.fn(),
        getSandboxType: jest.fn(),
        getSandboxInfo: jest.fn(() => null),
        getEffectivePreference: jest.fn(() => "e2b"),
        recordHealthFailure: jest.fn(() => false),
        resetHealthFailures: jest.fn(),
        isSandboxUnavailable: jest.fn(() => false),
        consumeFallbackInfo: jest.fn(() => ({
          occurred: true,
          reason: "no_local_connections",
          requestedPreference: "desktop",
          actualSandbox: "e2b",
          actualSandboxName: "Cloud",
        })),
      } as never,
      writer: {
        write: (part: unknown) => writerWrites.push(part),
      } as never,
    });
    const tool = createGetTerminalFiles(context);

    const result = (await runTool(tool, {
      brief: "Deliver report",
      files: ["/home/user/report.txt"],
    })) as {
      result: string;
      files: Array<{ path: string }>;
      failedFiles: Array<{ path: string; reason: string }>;
    };

    expect(mockUploadSandboxFileToConvex).not.toHaveBeenCalled();
    expect(result.files).toEqual([]);
    expect(result.failedFiles[0]?.reason).toContain(
      "HackerAI did not switch this run to Cloud",
    );
    expect(result.result).toContain(
      "HackerAI did not switch this run to Cloud",
    );
    expect(writerWrites).not.toContainEqual(
      expect.objectContaining({ type: "data-sandbox-fallback" }),
    );
  });

  it("reports partial upload failures without claiming every file was sent", async () => {
    mockUploadSandboxFileToConvex
      .mockResolvedValueOnce({
        url: "https://files.example/server.zip",
        fileId: "file_server" as never,
        tokens: 0,
        name: "server.zip",
        mediaType: "application/zip",
        s3Key: "users/u1/server.zip",
        sizeBytes: 1024,
      })
      .mockRejectedValueOnce(
        new Error(
          "Failed to upload file /home/user/client.zip: curl: (22) The requested URL returned error: 403",
        ),
      );

    const context = makeContext();
    const tool = createGetTerminalFiles(context);

    const result = (await runTool(tool, {
      brief: "Deliver both packages",
      files: ["/home/user/server.zip", "/home/user/client.zip"],
    })) as {
      result: string;
      files: Array<{ path: string }>;
      failedFiles: Array<{ path: string; reason: string }>;
    };

    expect(result.files).toEqual([{ path: "/home/user/server.zip" }]);
    expect(result.failedFiles).toHaveLength(1);
    expect(result.failedFiles[0]).toMatchObject({
      path: "/home/user/client.zip",
      reason: expect.stringContaining("403"),
    });
    expect(result.result).toContain("Partially provided 1 of 2 file(s)");
    expect(result.result).toContain(
      "Do not tell the user failed files were sent",
    );
    expect(result.result).not.toContain("Successfully provided 2");
    expect(context.fileAccumulator.add).toHaveBeenCalledTimes(1);
    expect(context.writer.write).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "data-file-metadata",
        data: expect.objectContaining({
          messageId: "assistant-1",
        }),
      }),
    );
  });
});
