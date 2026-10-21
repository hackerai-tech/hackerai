jest.mock("../utils/sandbox-file-uploader", () => ({
  uploadSandboxFileToConvex: jest.fn(),
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: jest.fn() },
}));

jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn() } }));

import { logger } from "@/lib/logger";
import { createGetTerminalFiles } from "../get-terminal-files";
import { uploadSandboxFileToConvex } from "../utils/sandbox-file-uploader";
import type { ToolContext } from "@/types";
import { phLogger } from "@/lib/posthog/server";
import { LocalCommandRelayUnsubscribedError } from "../utils/local-sandbox-errors";
import { trackForegroundCommand } from "../utils/foreground-commands";

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
    modelName: "model-grok-4.6",
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

  it("counts final failed files by phase without counting recovered candidate paths", async () => {
    const privateMessage = "private-target-and-signed-upload-url";
    mockUploadSandboxFileToConvex.mockImplementation(async (args) => {
      if (args.fullPath === "/home/user/recovered.txt") {
        args.onNativeStatFailure?.("file_missing");
        args.onPhase?.("file_metadata");
        throw new Error(privateMessage);
      }
      if (args.fullPath.endsWith("missing.txt")) {
        args.onNativeStatFailure?.("file_missing");
        args.onPhase?.("file_metadata");
        throw new Error(privateMessage);
      }
      if (args.fullPath === "/failed-upload.txt") {
        args.onPhase?.("transfer");
        throw new Error(privateMessage);
      }
      return {
        fileId: "stored-file" as never,
        url: "https://files.example/private",
        tokens: 0,
        name: "recovered.txt",
        mediaType: "text/plain",
        sizeBytes: 1,
      };
    });
    const context = makeContext();
    jest
      .mocked(context.sandboxManager.getSandboxInfo)
      .mockReturnValue({ type: "cloud" });
    const result = await runTool(createGetTerminalFiles(context), {
      files: ["recovered.txt", "missing.txt", "/failed-upload.txt"],
    });

    expect(result).toMatchObject({
      files: [{ path: "recovered.txt" }],
      failedFiles: [{ path: "missing.txt" }, { path: "/failed-upload.txt" }],
    });
    expect(logger.warn).not.toHaveBeenCalled();
    const [, fields] = jest.mocked(phLogger.event).mock.calls.at(-1)!;
    expect(fields).toMatchObject({
      delivered_file_count: 1,
      failed_file_count: 2,
      file_delivery_diagnostic_version: 1,
      failure_phase_counts: { file_metadata: 1, transfer: 1 },
      metadata_failure_diagnostic_version: 1,
      metadata_failure_reason_counts: { native_file_missing: 1 },
    });
    expect(JSON.stringify(fields)).not.toMatch(
      /private-target|signed-upload|missing\.txt|failed-upload\.txt|recovered\.txt/,
    );
  });

  it("counts only the final metadata reason and bounds invalid observer values", async () => {
    const context = makeContext();
    jest
      .mocked(context.sandboxManager.getSandboxInfo)
      .mockReturnValue({ type: "cloud" });
    mockUploadSandboxFileToConvex.mockImplementation(async (args) => {
      args.onPhase?.("file_metadata");
      const reason =
        args.fullPath === "/home/user/report.txt"
          ? "file_missing"
          : args.fullPath === "report.txt"
            ? "stat_failed"
            : "PRIVATE signed-url/path";
      (args.onNativeStatFailure as ((value: string) => void) | undefined)?.(
        reason,
      );
      throw new Error("PRIVATE file error");
    });
    await runTool(createGetTerminalFiles(context), {
      files: ["report.txt", "/other.txt"],
    });
    const [, fields] = jest.mocked(phLogger.event).mock.calls.at(-1)!;
    expect(fields).toMatchObject({
      failed_file_count: 2,
      failure_phase_counts: { file_metadata: 2 },
      metadata_failure_diagnostic_version: 1,
      metadata_failure_reason_counts: {
        native_stat_failed: 1,
        unclassified: 1,
      },
    });
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(fields)).not.toMatch(
      /PRIVATE|report|other|signed-url|path/,
    );
  });

  it("reports setup failures for every requested file without invoking uploads", async () => {
    const context = makeContext();
    jest
      .mocked(context.sandboxManager.getSandbox)
      .mockRejectedValueOnce(new Error("private-acquisition-error"));
    await runTool(createGetTerminalFiles(context), {
      files: ["/one.txt", "/two.txt"],
    });
    expect(mockUploadSandboxFileToConvex).not.toHaveBeenCalled();
    expect(phLogger.event).toHaveBeenLastCalledWith(
      "agent_file_delivery_completed",
      expect.objectContaining({
        failed_file_count: 2,
        failure_phase_counts: { sandbox_setup: 2 },
      }),
    );
  });

  it.each([false, true])(
    "logs bounded acquisition diagnostics even if the logger throws (%s)",
    async (loggingThrows) => {
      const context = makeContext({ triggerRunId: "run-opaque" });
      const error = new Error(
        "PRIVATE setup path /secret/file signed-url?token=secret",
      );
      jest
        .mocked(context.sandboxManager.getSandbox)
        .mockRejectedValueOnce(error);
      if (loggingThrows)
        jest.mocked(logger.warn).mockImplementationOnce(() => {
          throw new Error("logger unavailable");
        });
      const result = await runTool(createGetTerminalFiles(context), {
        files: ["/secret/one", "/secret/two"],
      });
      expect(result).toMatchObject({
        files: [],
        failedFiles: [
          { path: "/secret/one", reason: error.message },
          { path: "/secret/two", reason: error.message },
        ],
      });
      expect(mockUploadSandboxFileToConvex).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_file_delivery_setup_failed",
        {
          setup_stage: "initial_acquisition",
          abort_signal_aborted: false,
          chat_id: "chat-1",
          trigger_run_id: "run-opaque",
          requested_file_count: 2,
        },
      );
      expect(JSON.stringify(jest.mocked(logger.warn).mock.calls)).not.toMatch(
        /PRIVATE|secret|token|logger unavailable/,
      );
    },
  );

  it("distinguishes sandbox reacquisition after foreground commands without retrying", async () => {
    const context = makeContext();
    jest
      .mocked(context.sandboxManager.getSandbox)
      .mockResolvedValueOnce({ sandbox: { id: "sandbox-1" } } as never)
      .mockRejectedValueOnce(new Error("PRIVATE reacquisition"));
    let finish!: () => void;
    const command = trackForegroundCommand(
      context,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    try {
      const delivery = runTool(createGetTerminalFiles(context), {
        files: ["/secret/file"],
      });
      // Let delivery reach the real foreground wait before the command finishes.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(context.sandboxManager.getSandbox).toHaveBeenCalledTimes(1);
      finish();
      const result = await delivery;
      expect(result).toMatchObject({
        files: [],
        deliveryReceipts: [],
        failedFiles: [{ path: "/secret/file" }],
      });
      expect(context.sandboxManager.getSandbox).toHaveBeenCalledTimes(2);
      expect(mockUploadSandboxFileToConvex).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_file_delivery_setup_failed",
        expect.objectContaining({
          setup_stage: "reacquisition",
          abort_signal_aborted: false,
          requested_file_count: 1,
        }),
      );
    } finally {
      finish();
      await command;
    }
  });

  it.each([false, true])(
    "retains earlier failure phases when later setup aborts the batch (stored earlier: %s)",
    async (storedEarlier) => {
      const context = makeContext();
      const info = jest.mocked(context.sandboxManager.getSandboxInfo);
      if (storedEarlier) info.mockReturnValueOnce(null);
      info.mockImplementationOnce(() => {
        throw new Error("private-later-setup-error");
      });
      if (storedEarlier) {
        mockUploadSandboxFileToConvex.mockResolvedValueOnce({
          fileId: "stored-file" as never,
          url: "https://files.example/private",
          tokens: 0,
          name: "stored.txt",
          mediaType: "text/plain",
          sizeBytes: 1,
        });
      }
      mockUploadSandboxFileToConvex.mockImplementationOnce(async (args) => {
        args.onPhase?.("transfer");
        throw new Error("private-transfer-error");
      });
      const files = [
        ...(storedEarlier ? ["/stored.txt"] : []),
        "/failed.txt",
        "later.txt",
      ];

      const result = await runTool(createGetTerminalFiles(context), { files });

      expect(logger.warn).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_file_delivery_setup_failed",
        expect.objectContaining({
          setup_stage: "path_preparation",
          abort_signal_aborted: false,
          requested_file_count: files.length,
        }),
      );
      // Keep the existing whole-batch error result, while retaining the phase
      // already observed for the earlier failed file. Earlier stored files have
      // no known upload failure phase when this outer error discards the result.
      expect(result).toMatchObject({ files: [], deliveryReceipts: [] });
      expect(phLogger.event).toHaveBeenLastCalledWith(
        "agent_file_delivery_completed",
        expect.objectContaining({
          delivered_file_count: 0,
          failed_file_count: files.length,
          failure_phase_counts: {
            transfer: 1,
            sandbox_setup: 1,
            ...(storedEarlier ? { unknown: 1 } : {}),
          },
        }),
      );
    },
  );

  it("does not upload when delivery is stopped while creation is pending", async () => {
    const context = makeContext();
    let finish!: () => void;
    const command = trackForegroundCommand(
      context,
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const delivery = (createGetTerminalFiles(context).execute as any)(
      { files: ["/tmp/report.txt"] },
      { toolCallId: "delivery", messages: [], abortSignal: controller.signal },
    );
    controller.abort(new DOMException("Stopped", "AbortError"));
    try {
      expect(await delivery).toMatchObject({
        files: [],
        deliveryReceipts: [],
        failedFiles: [{ path: "/tmp/report.txt" }],
      });
      expect(mockUploadSandboxFileToConvex).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        "agent_file_delivery_setup_failed",
        expect.objectContaining({
          setup_stage: "foreground_wait",
          abort_signal_aborted: true,
        }),
      );
    } finally {
      finish();
      await command;
    }
  });

  it.each(["cloud", "desktop", "remote-connection"] as const)(
    "retains the original stored file when a %s stream disconnects",
    async (type) => {
      mockUploadSandboxFileToConvex.mockResolvedValue({
        url: "https://files.example/report.zip?signature=private",
        fileId: "stored-file" as never,
        tokens: 0,
        name: "report.zip",
        mediaType: "application/zip",
        s3Key: "private-key",
        sizeBytes: 1024,
      });
      const context = makeContext();
      jest
        .mocked(context.sandboxManager.getSandboxInfo)
        .mockReturnValue({ type });
      jest.mocked(context.writer.write).mockImplementation(() => {
        throw new Error("Stream closed");
      });
      const result = await runTool(createGetTerminalFiles(context), {
        files: ["report.zip"],
      });
      expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(1);
      expect(context.fileAccumulator.add).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({
        files: [{ path: "report.zip" }],
        deliveryReceipts: [{ fileId: "stored-file", storageStatus: "stored" }],
        failedFiles: [],
      });
      expect(phLogger.event).toHaveBeenCalledWith(
        "agent_file_delivery_completed",
        expect.objectContaining({
          delivered_file_count: 1,
          failed_file_count: 0,
          stream_notification_failed_count: 1,
        }),
      );
      expect(
        JSON.stringify(jest.mocked(phLogger.event).mock.calls),
      ).not.toMatch(/report\.zip|private-key|signature|Stream closed/);
    },
  );

  it("keeps storage failures separate from notification and analytics failures", async () => {
    mockUploadSandboxFileToConvex.mockReset();
    mockUploadSandboxFileToConvex
      .mockResolvedValueOnce({
        url: "https://files.example/report.zip",
        fileId: "stored-file" as never,
        tokens: 0,
        name: "report.zip",
        mediaType: "application/zip",
        sizeBytes: 1024,
      })
      .mockRejectedValueOnce(new Error("Storage unavailable"));
    const context = makeContext();
    jest.mocked(context.writer.write).mockImplementation(() => {
      throw new Error("Stream closed");
    });
    jest.mocked(phLogger.event).mockImplementationOnce(() => {
      throw new Error("Analytics unavailable");
    });
    const result = await runTool(createGetTerminalFiles(context), {
      files: ["/report.zip", "/missing.zip"],
    });
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      files: [{ path: "/report.zip" }],
      deliveryReceipts: [{ fileId: "stored-file" }],
      failedFiles: [{ path: "/missing.zip" }],
    });
  });

  it.each(["desktop", "remote-connection", null] as const)(
    "does not prefer a Cloud path over the selected %s working directory",
    async (type) => {
      mockUploadSandboxFileToConvex.mockResolvedValue({
        url: "https://files.example/report.zip?signature=private",
        fileId: "file_report" as never,
        tokens: 0,
        name: "report.zip",
        mediaType: "application/zip",
        s3Key: "private-storage-key",
        sizeBytes: 1024,
      });
      const context = makeContext();
      jest
        .mocked(context.sandboxManager.getSandboxInfo)
        .mockReturnValue(type ? { type } : null);

      const result = await runTool(createGetTerminalFiles(context), {
        files: ["report.zip"],
      });

      expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(1);
      expect(mockUploadSandboxFileToConvex).toHaveBeenCalledWith(
        expect.objectContaining({ fullPath: "report.zip" }),
      );
      expect(result).toMatchObject({
        files: [{ path: "report.zip" }],
        deliveryReceipts: [
          {
            fileId: "file_report",
            sourcePath: "report.zip",
            name: "report.zip",
            sizeBytes: 1024,
            sourceEnvironment: type ?? "unknown",
            storageStatus: "stored",
            validation: "not_performed_by_delivery_tool",
          },
        ],
        failedFiles: [],
      });
      expect(JSON.stringify(result)).not.toMatch(
        /signature|private-storage-key/,
      );
      expect(
        JSON.stringify(jest.mocked(phLogger.event).mock.calls),
      ).not.toMatch(/report\.zip|file_report|signature|private-storage-key/);
    },
  );

  it("keeps Cloud fallback paths and records the path that actually uploaded", async () => {
    mockUploadSandboxFileToConvex
      .mockRejectedValueOnce(new Error("File not found"))
      .mockResolvedValueOnce({
        url: "https://files.example/report.zip",
        fileId: "file_report" as never,
        tokens: 0,
        name: "report.zip",
        mediaType: "application/zip",
        sizeBytes: 1024,
      });
    const context = makeContext();
    jest
      .mocked(context.sandboxManager.getSandboxInfo)
      .mockReturnValue({ type: "cloud" });

    const result = await runTool(createGetTerminalFiles(context), {
      files: ["report.zip"],
    });

    expect(
      mockUploadSandboxFileToConvex.mock.calls.map(([args]) => args.fullPath),
    ).toEqual(["/home/user/report.zip", "report.zip"]);
    expect(result).toMatchObject({
      deliveryReceipts: [
        { sourcePath: "report.zip", sourceEnvironment: "cloud" },
      ],
    });
  });

  it.each([false, true])(
    "does not issue a receipt for an undelivered file (active writer: %s)",
    async (active) => {
      const context = makeContext();
      mockUploadSandboxFileToConvex.mockRejectedValue(
        new Error("Upload unavailable"),
      );
      jest
        .mocked(context.backgroundProcessTracker.hasActiveProcessesForFiles)
        .mockResolvedValue({ active, processes: [] });

      const result = await runTool(createGetTerminalFiles(context), {
        files: ["/work/report.zip"],
      });

      expect(result).toMatchObject({
        files: [],
        deliveryReceipts: [],
        failedFiles: [{ path: "/work/report.zip" }],
      });
      expect(context.fileAccumulator.add).not.toHaveBeenCalled();
      expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(
        active ? 0 : 1,
      );
    },
  );

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
    expect(result).toHaveProperty("deliveryReceipts", []);
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
    expect(result).toHaveProperty("deliveryReceipts", [
      expect.objectContaining({
        fileId: "file_server",
        sourcePath: "/home/user/server.zip",
      }),
    ]);
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
    expect(phLogger.event).toHaveBeenCalledWith(
      "agent_file_delivery_completed",
      expect.objectContaining({
        delivered_file_count: 1,
        failed_file_count: 1,
      }),
    );
    expect(
      JSON.stringify(jest.mocked(phLogger.event).mock.calls),
    ).not.toContain("client.zip");
  });
  it.each([
    "C:\\Users\\User\\Documents\\report.zip",
    "\\\\server\\share\\report.zip",
  ])("keeps Windows absolute path %s on the selected host", async (path) => {
    mockUploadSandboxFileToConvex.mockResolvedValue({
      url: "https://files.example/report.zip",
      fileId: "file_report" as never,
      tokens: 0,
      name: "report.zip",
      mediaType: "application/zip",
      sizeBytes: 1024,
    });
    const result = (await runTool(createGetTerminalFiles(makeContext()), {
      files: [path],
    })) as { failedFiles: unknown[] };
    expect(result.failedFiles).toHaveLength(0);
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(1);
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledWith(
      expect.objectContaining({ fullPath: path }),
    );
  });
  it("recovers a stale local relay once and delivers from its replacement", async () => {
    const stale = { sandboxKind: "centrifugo", getConnectionId: () => "old" };
    const replacement = {
      sandboxKind: "centrifugo",
      getConnectionId: () => "new",
    };
    const recoverLocalConnection = jest.fn(async () => ({
      sandbox: replacement,
    }));
    const getSandbox = jest
      .fn()
      .mockResolvedValueOnce({ sandbox: stale })
      .mockResolvedValueOnce({ sandbox: replacement });
    mockUploadSandboxFileToConvex
      .mockRejectedValueOnce(new LocalCommandRelayUnsubscribedError("old"))
      .mockResolvedValueOnce({
        url: "https://files.example/report.zip",
        fileId: "file_report" as never,
        tokens: 0,
        name: "report.zip",
        mediaType: "application/zip",
        sizeBytes: 1024,
      });
    const base = makeContext();
    const context = makeContext({
      sandboxManager: {
        ...base.sandboxManager,
        getSandbox,
        recoverLocalConnection,
      },
    });
    const result = (await runTool(createGetTerminalFiles(context), {
      files: ["C:\\report.zip"],
    })) as { failedFiles: unknown[]; files: unknown[] };
    expect(result.files).toHaveLength(1);
    expect(result.failedFiles).toHaveLength(0);
    expect(recoverLocalConnection).toHaveBeenCalledWith(
      "old",
      "command_relay_unsubscribed",
    );
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(2);
    expect(mockUploadSandboxFileToConvex).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sandbox: replacement,
        fullPath: "C:\\report.zip",
      }),
    );
    expect(phLogger.event).toHaveBeenCalledWith(
      "agent_file_delivery_completed",
      expect.objectContaining({
        relay_recovery_attempted: true,
        relay_recovery_succeeded: true,
        delivered_file_count: 1,
        metadata_failure_reason_counts: {},
      }),
    );
  });
  it("does not carry a native metadata reason across a relay recovery attempt", async () => {
    const stale = { sandboxKind: "centrifugo", getConnectionId: () => "old" };
    const replacement = {
      sandboxKind: "centrifugo",
      getConnectionId: () => "new",
    };
    const base = makeContext();
    const recoverLocalConnection = jest.fn(async () => ({
      sandbox: replacement,
    }));
    const context = makeContext({
      sandboxManager: {
        ...base.sandboxManager,
        getSandbox: jest
          .fn()
          .mockResolvedValueOnce({ sandbox: stale })
          .mockResolvedValueOnce({ sandbox: replacement }),
        recoverLocalConnection,
      },
    });
    mockUploadSandboxFileToConvex
      .mockImplementationOnce(async (args) => {
        args.onPhase?.("file_metadata");
        args.onNativeStatFailure?.("stat_failed");
        throw new LocalCommandRelayUnsubscribedError("old");
      })
      .mockImplementationOnce(async (args) => {
        args.onPhase?.("file_metadata");
        throw new Error("PRIVATE unclassified metadata failure");
      });
    await runTool(createGetTerminalFiles(context), { files: ["/report.txt"] });
    expect(recoverLocalConnection).toHaveBeenCalledTimes(1);
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(2);
    expect(phLogger.event).toHaveBeenLastCalledWith(
      "agent_file_delivery_completed",
      expect.objectContaining({
        failed_file_count: 1,
        failure_phase_counts: { file_metadata: 1 },
        metadata_failure_reason_counts: { unclassified: 1 },
      }),
    );
  });

  it("does not retry local files on a cloud sandbox after relay recovery", async () => {
    const stale = { sandboxKind: "centrifugo", getConnectionId: () => "old" };
    const cloud = { id: "cloud" };
    const base = makeContext();
    const context = makeContext({
      sandboxManager: {
        ...base.sandboxManager,
        getSandbox: jest
          .fn()
          .mockResolvedValueOnce({ sandbox: stale })
          .mockResolvedValueOnce({ sandbox: cloud }),
        recoverLocalConnection: jest.fn(async () => ({ sandbox: cloud })),
      },
    });
    mockUploadSandboxFileToConvex.mockRejectedValueOnce(
      new LocalCommandRelayUnsubscribedError("old"),
    );
    const result = (await runTool(createGetTerminalFiles(context), {
      files: ["C:\\report.zip"],
    })) as { failedFiles: Array<{ reason: string }> };
    expect(result.failedFiles[0].reason).toContain(
      "selected local sandbox changed",
    );
    expect(mockUploadSandboxFileToConvex).toHaveBeenCalledTimes(1);
  });
});
