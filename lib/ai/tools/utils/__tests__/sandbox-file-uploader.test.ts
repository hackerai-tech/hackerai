jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/convex/s3Utils", () => ({
  generateS3UploadUrl: jest.fn(),
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(),
}));

import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import { LocalFileRequestError } from "../local-sandbox-errors";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_GENERATED_FILE_SIZE_BYTES,
} from "@/lib/constants/s3";
import {
  getSandboxUploadedFileUrl,
  uploadSandboxFileToConvex,
} from "../sandbox-file-uploader";

const mockGenerateS3UploadUrl = generateS3UploadUrl as jest.MockedFunction<
  typeof generateS3UploadUrl
>;
const mockGetConvexClient = getConvexClient as jest.MockedFunction<
  typeof getConvexClient
>;
let mockConvexAction: jest.Mock;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

function makeSandbox(size: number, e2b = false, windows = false) {
  return {
    ...(e2b ? {} : { sandboxKind: "centrifugo" as const }),
    isWindows: jest.fn(() => windows),
    detectShell: jest.fn(async () => (windows ? "cmd" : "bash")),
    commands: {
      run: jest.fn(async (command: string) => {
        if (command.includes("stat -Lc%s")) {
          return { stdout: String(size), stderr: "", exitCode: 0 };
        }
        if (command.startsWith("for %I")) {
          return { stdout: String(size), stderr: "", exitCode: 0 };
        }
        if (command.includes("curl -fsSL -X PUT")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      }),
    },
    files: {
      uploadToUrl: jest.fn(async () => undefined),
    },
    downloadUrl: jest.fn(async () => "https://sandbox.example/file"),
  };
}

describe("uploadSandboxFileToConvex", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://convex.example";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockGenerateS3UploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example/upload",
      s3Key: "users/u1/file.txt",
      storageLocation: {
        region: "us-west-2",
        bucket: "test-west-bucket",
      },
    });
    mockConvexAction = jest.fn(async () => ({
      url: "https://s3.example/download",
      fileId: "file_123",
      tokens: 0,
    }));
    mockGetConvexClient.mockReturnValue({
      action: mockConvexAction,
    } as any);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test.each([
    "file_metadata",
    "upload_url",
    "transfer",
    "file_registration",
  ] as const)(
    "retains the failing %s phase without exporting the failure contents",
    async (phase) => {
      const error = Object.freeze(new Error("private-upload-error"));
      const sandbox = makeSandbox(10);
      if (phase === "file_metadata") {
        sandbox.commands.run.mockRejectedValueOnce(error);
      } else if (phase === "upload_url") {
        mockGenerateS3UploadUrl.mockRejectedValueOnce(error);
      } else if (phase === "transfer") {
        sandbox.files.uploadToUrl.mockRejectedValueOnce(error);
        const originalRun = sandbox.commands.run.getMockImplementation()!;
        sandbox.commands.run.mockImplementation(async (command) => {
          if (command.includes("curl -fsSL -X PUT")) throw error;
          return originalRun(command);
        });
      } else {
        mockConvexAction.mockRejectedValueOnce(error);
      }
      const onPhase = jest.fn();

      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "/private/report.txt",
          onPhase,
        }),
      ).rejects.toThrow("private-upload-error");
      expect(onPhase).toHaveBeenLastCalledWith(phase);
      expect(JSON.stringify(onPhase.mock.calls)).not.toMatch(/private|report/);
    },
  );

  test("a failing diagnostics observer cannot prevent a file upload", async () => {
    const sandbox = makeSandbox(10);
    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/report.txt",
        onPhase: () => {
          throw new Error("observer unavailable");
        },
      }),
    ).resolves.toMatchObject({ fileId: "file_123", sizeBytes: 10 });
  });

  test.each([false, true])(
    "an async diagnostics rejection cannot change the upload outcome (upload fails: %s)",
    async (uploadFails) => {
      const sandbox = makeSandbox(10);
      const uploadError = Object.freeze(new Error("private-metadata-error"));
      if (uploadFails) sandbox.commands.run.mockRejectedValueOnce(uploadError);
      const result = uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/report.txt",
        onPhase: async () => {
          throw new Error("observer unavailable");
        },
      });

      if (uploadFails) await expect(result).rejects.toBe(uploadError);
      else await expect(result).resolves.toMatchObject({ fileId: "file_123" });
    },
  );

  test("mints a fresh user-scoped URL for an uploaded sandbox file", async () => {
    mockConvexAction.mockResolvedValueOnce([
      "https://s3.example/download?signature=fresh",
    ]);

    await expect(
      getSandboxUploadedFileUrl({
        fileId: "file_123" as never,
        userId: "u1",
      }),
    ).resolves.toBe("https://s3.example/download?signature=fresh");

    expect(mockConvexAction).toHaveBeenCalledWith(expect.anything(), {
      serviceKey: "service-key",
      userId: "u1",
      fileIds: ["file_123"],
    });
  });

  test("returns undefined when an uploaded sandbox file is unavailable", async () => {
    mockConvexAction.mockResolvedValueOnce([null]);

    await expect(
      getSandboxUploadedFileUrl({
        fileId: "missing_file" as never,
        userId: "u1",
      }),
    ).resolves.toBeUndefined();
  });

  test("rejects oversized Centrifugo files before uploading to S3", async () => {
    const sandbox = makeSandbox(MAX_GENERATED_FILE_SIZE_BYTES + 1);

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/large.tar.gz",
      }),
    ).rejects.toThrow(/exceeds the maximum generated file size limit/);

    expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    expect(mockGetConvexClient).not.toHaveBeenCalled();
    expect(mockConvexAction).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"sandbox_generated_file_too_large"'),
    );
  });

  test("rejects oversized E2B files before uploading to S3", async () => {
    const sandbox = makeSandbox(MAX_GENERATED_FILE_SIZE_BYTES + 1, true);

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/large.tar.gz",
      }),
    ).rejects.toThrow(/exceeds the maximum generated file size limit/);

    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(sandbox.downloadUrl).not.toHaveBeenCalled();
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    expect(mockGetConvexClient).not.toHaveBeenCalled();
  });

  test("allows generated artifacts above the user upload limit", async () => {
    const sandbox = makeSandbox(MAX_FILE_SIZE_BYTES + 1);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/archive.tar.gz",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalled();
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "archive.tar.gz",
        size: MAX_FILE_SIZE_BYTES + 1,
      }),
    );
  });

  test("uploads allowed Centrifugo files using the preflight size", async () => {
    const sandbox = makeSandbox(1234);

    const saved = await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/report.txt",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalledWith(
      "/home/user/report.txt",
      "https://s3.example/upload",
      "application/octet-stream",
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "report.txt",
        size: 1234,
        s3Key: "users/u1/file.txt",
        s3Region: "us-west-2",
        s3Bucket: "test-west-bucket",
      }),
    );
    expect(saved).toMatchObject({
      name: "report.txt",
      s3Key: "users/u1/file.txt",
    });
  });

  test.each([0, 4321])(
    "uses native Desktop metadata for a %s-byte file when shell size checks cannot run",
    async (size) => {
      const sandbox = {
        ...makeSandbox(size, false, true),
        supportsNativeFileRelay: () => true,
      };
      const stat = jest.fn().mockResolvedValue({
        kind: "file",
        path: "C:\\repo\\report & review!.zip",
        sizeBytes: size,
      });
      Object.assign(sandbox.files, { stat });
      sandbox.commands.run.mockResolvedValue({
        stdout: "ECHO is on.\r\n",
        stderr: "The syntax of the command is incorrect.",
        exitCode: 1,
      });

      const saved = await uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "C:\\repo\\report & review!.zip",
      });

      expect(saved.sizeBytes).toBe(size);
      expect(stat).toHaveBeenCalledWith("C:\\repo\\report & review!.zip");
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
        "report & review!.zip",
        "application/octet-stream",
        "u1",
        size,
      );
    },
  );

  test.each([
    [
      { kind: "missing", path: "C:\\repo\\report.zip" },
      /File not found/,
      "file_missing",
    ],
    [
      { kind: "not_file", path: "C:\\repo\\report.zip" },
      /not a regular file/,
      "not_regular_file",
    ],
    [{ kind: "file", sizeBytes: -1 }, /invalid file size/, "invalid_file_size"],
    [
      { kind: "file", sizeBytes: NaN },
      /invalid file size/,
      "invalid_file_size",
    ],
    [
      { kind: "file", sizeBytes: 1.5 },
      /invalid file size/,
      "invalid_file_size",
    ],
    [
      { kind: "file", sizeBytes: undefined },
      /invalid file size/,
      "invalid_file_size",
    ],
    [
      { kind: "file", sizeBytes: MAX_GENERATED_FILE_SIZE_BYTES + 1 },
      /exceeds the maximum generated file size/,
      undefined,
    ],
  ])(
    "rejects native preflight %j before upload",
    async (metadata, message, reason) => {
      const observed = jest.fn();
      const sandbox = {
        ...makeSandbox(42, false, true),
        supportsNativeFileRelay: () => true,
      };
      Object.assign(sandbox.files, {
        stat: jest.fn().mockResolvedValue(metadata),
      });

      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "C:\\repo\\report.zip",
          onNativeStatFailure: observed,
        }),
      ).rejects.toThrow(message);
      if (reason) {
        expect(observed).toHaveBeenCalledTimes(1);
        expect(observed).toHaveBeenCalledWith(reason);
      } else {
        expect(observed).not.toHaveBeenCalled();
      }

      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
      expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
      expect(mockConvexAction).not.toHaveBeenCalled();
      const diagnostics = consoleWarnSpy.mock.calls
        .map(([entry]) => JSON.parse(entry))
        .filter(
          (entry) =>
            entry.event === "sandbox_generated_file_native_stat_failed",
        );
      expect(diagnostics).toEqual(
        reason
          ? [
              {
                level: "warn",
                message: "sandbox_generated_file_native_stat_failed",
                timestamp: expect.any(String),
                event: "sandbox_generated_file_native_stat_failed",
                service: "chat-handler",
                sandbox_type: "desktop",
                failure_reason: reason,
              },
            ]
          : [],
      );
    },
  );

  test.each([false, true])(
    "preserves a native denial without shell fallback when logging fails: %s",
    async (loggingFails) => {
      const sandbox = {
        ...makeSandbox(42),
        supportsNativeFileRelay: () => true,
      };
      const error = Object.freeze(
        new Error("Metadata error: private permission denial"),
      );
      const stat = jest.fn().mockRejectedValue(error);
      Object.assign(sandbox.files, { stat });
      if (loggingFails) {
        consoleWarnSpy.mockImplementation(() => {
          throw new Error("logger unavailable");
        });
      }

      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "/protected/report.zip",
        }),
      ).rejects.toBe(error);
      expect(stat).toHaveBeenCalledTimes(1);
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
      expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
      expect(mockConvexAction).not.toHaveBeenCalled();
      if (!loggingFails) {
        expect(consoleWarnSpy).toHaveBeenCalledTimes(1);
        expect(JSON.parse(consoleWarnSpy.mock.calls[0][0])).toEqual({
          level: "warn",
          message: "sandbox_generated_file_native_stat_failed",
          timestamp: expect.any(String),
          event: "sandbox_generated_file_native_stat_failed",
          service: "chat-handler",
          sandbox_type: "desktop",
          failure_reason: "stat_failed",
          native_stat_error_category: "unknown",
        });
      }
    },
  );

  test.each([
    "unavailable",
    "aborted",
    "timeout",
    "native_error",
    "subscription_error",
    "relay_unsubscribed",
    "readiness_timeout",
    "dispatch_error",
    "PRIVATE-invalid-category",
  ] as const)(
    "records only a bounded native stat category (%s) and preserves the error",
    async (failure) => {
      const sandbox = {
        ...makeSandbox(42),
        supportsNativeFileRelay: () => true,
      };
      const error = Object.freeze(
        new LocalFileRequestError(
          failure as any,
          "PRIVATE-error-with-path-and-url",
        ),
      );
      Object.assign(sandbox.files, {
        stat: jest.fn().mockRejectedValue(error),
      });
      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "/PRIVATE-path/report.zip",
        }),
      ).rejects.toBe(error);
      const records = consoleWarnSpy.mock.calls.map(([entry]) =>
        JSON.parse(entry),
      );
      expect(records).toEqual([
        expect.objectContaining({
          failure_reason: "stat_failed",
          native_stat_error_category:
            failure === "PRIVATE-invalid-category" ? "unknown" : failure,
        }),
      ]);
      expect(JSON.stringify(records)).not.toContain("PRIVATE");
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
      expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
      expect(mockConvexAction).not.toHaveBeenCalled();
    },
  );

  test.each(["throw", "reject"])(
    "preserves a frozen native stat error when its observer fails (%s)",
    async (mode) => {
      const sandbox = {
        ...makeSandbox(42),
        supportsNativeFileRelay: () => true,
      };
      const original = Object.freeze(new Error("PRIVATE stat error"));
      Object.assign(sandbox.files, {
        stat: jest.fn().mockRejectedValue(original),
      });
      const observed = jest.fn(() => {
        if (mode === "throw") throw new Error("observer unavailable");
        return Promise.reject(new Error("observer unavailable"));
      });
      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "/private/report.zip",
          onNativeStatFailure: observed,
        }),
      ).rejects.toBe(original);
      await Promise.resolve();
      expect(observed).toHaveBeenCalledTimes(1);
      expect(observed).toHaveBeenCalledWith("stat_failed");
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
      expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    },
  );

  test.each([true, false])(
    "preserves a Windows native upload failure without a POSIX fallback (fallback would succeed: %s)",
    async (fallbackWouldSucceed) => {
      const nativeError = new Error("Native upload connection closed");
      const sandbox = {
        ...makeSandbox(1234, false, true),
        supportsNativeFileRelay: () => true,
      };
      sandbox.files = {
        ...sandbox.files,
        stat: jest.fn(async () => ({ kind: "file", sizeBytes: 1234 })),
      } as typeof sandbox.files;
      sandbox.files.uploadToUrl.mockRejectedValueOnce(nativeError);
      sandbox.commands.run.mockResolvedValue({
        stdout: "",
        stderr: fallbackWouldSucceed ? "" : "curl is not recognized",
        exitCode: fallbackWouldSucceed ? 0 : 1,
      });
      const onPhase = jest.fn();

      await expect(
        uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "C:\\project\\report.txt",
          onPhase,
        }),
      ).rejects.toBe(nativeError);
      expect(onPhase).toHaveBeenLastCalledWith("transfer");
      expect(sandbox.files.uploadToUrl).toHaveBeenCalledTimes(1);
      expect(sandbox.commands.run).not.toHaveBeenCalled();
      expect(mockConvexAction).not.toHaveBeenCalled();
    },
  );

  test("falls back to command upload when native Centrifugo upload fails", async () => {
    const sandbox = makeSandbox(1234);
    sandbox.files.uploadToUrl.mockRejectedValueOnce(new Error("exit status 1"));

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/preview.png",
      mediaType: "image/png",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalledWith(
      "/home/user/preview.png",
      "https://s3.example/upload",
      "image/png",
    );
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("curl -fsSL -X PUT -H 'Content-Type: image/png'"),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "preview.png",
        size: 1234,
      }),
    );
  });

  test.each([true, false])(
    "adds numeric signing diagnostics while preserving the original upload failure (native Windows: %s)",
    async (nativeWindows) => {
      const clock = jest
        .spyOn(Date, "now")
        .mockReturnValue(Date.parse("2026-10-25T17:57:09Z"));
      const url =
        "https://s3.example/upload?X-Amz-Date=20261025T175700Z&X-Amz-Expires=60&X-Amz-Signature=fixture-signature";
      mockGenerateS3UploadUrl.mockResolvedValueOnce({
        uploadUrl: url,
        s3Key: "users/u1/file.txt",
        storageLocation: { region: "us-west-2", bucket: "test-west-bucket" },
      });
      const sandbox = {
        ...makeSandbox(1234, !nativeWindows, nativeWindows),
        ...(nativeWindows && { supportsNativeFileRelay: () => true }),
      };
      if (nativeWindows) {
        Object.assign(sandbox.files, {
          stat: jest.fn(async () => ({ kind: "file", sizeBytes: 1234 })),
        });
      }
      const error = new Error(
        "Failed to upload file: curl: (22) The requested URL returned error: 403",
      );
      if (nativeWindows) {
        sandbox.files.uploadToUrl.mockRejectedValueOnce(error);
      } else {
        const run = sandbox.commands.run.getMockImplementation()!;
        sandbox.commands.run.mockImplementation(async (command) =>
          command.includes("curl -fsSL -X PUT")
            ? {
                stdout: "",
                stderr: "curl: (22) The requested URL returned error: 403",
                exitCode: 22,
              }
            : run(command),
        );
      }
      try {
        const result = uploadSandboxFileToConvex({
          sandbox: sandbox as any,
          userId: "u1",
          fullPath: "/report.txt",
        });
        if (nativeWindows) await expect(result).rejects.toBe(error);
        else
          await expect(result).rejects.toThrow(
            "The requested URL returned error: 403",
          );
        const calls = nativeWindows
          ? consoleWarnSpy.mock.calls
          : consoleErrorSpy.mock.calls;
        const event = calls
          .map(([line]) => JSON.parse(line))
          .find(
            (value) =>
              value.event ===
              (nativeWindows
                ? "sandbox_generated_file_native_upload_failed"
                : "sandbox_generated_file_upload_failed"),
          );
        expect(event).toMatchObject({
          upload_reported_http_status: 403,
          upload_signature_age_ms: 9_000,
          upload_signature_ttl_ms: 60_000,
          upload_signature_remaining_ms: 51_000,
        });
        expect(JSON.stringify(calls)).not.toMatch(/fixture-signature|X-Amz/);
        expect(mockConvexAction).not.toHaveBeenCalled();
        if (nativeWindows)
          expect(sandbox.files.uploadToUrl).toHaveBeenCalledTimes(1);
        else expect(sandbox.commands.run).toHaveBeenCalledTimes(2);
      } finally {
        clock.mockRestore();
      }
    },
  );

  test("retains diagnostic status from a command error message when stderr is empty", async () => {
    const sandbox = makeSandbox(1234, true);
    const originalRun = sandbox.commands.run.getMockImplementation()!;
    const error = Object.assign(
      new Error("curl: (22) The requested URL returned error: 403"),
      { exitCode: 22, stderr: "" },
    );
    sandbox.commands.run.mockImplementation(async (command) => {
      if (command.includes("curl -fsSL -X PUT")) throw error;
      return originalRun(command);
    });

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/report.txt",
      }),
    ).rejects.toThrow("curl: (22) The requested URL returned error: 403");
    const event = consoleErrorSpy.mock.calls
      .map(([line]) => JSON.parse(line))
      .find((value) => value.event === "sandbox_generated_file_upload_failed");
    expect(event).toMatchObject({
      upload_reported_http_status: 403,
      exit_code: 22,
    });
    expect(sandbox.commands.run).toHaveBeenCalledTimes(2);
    expect(mockConvexAction).not.toHaveBeenCalled();
  });

  test("reports command upload stderr instead of a bare exit status", async () => {
    const sandbox = makeSandbox(1234, true);
    (sandbox.commands.run as jest.Mock).mockImplementation(
      async (command: string) => {
        if (command.includes("stat -Lc%s")) {
          return { stdout: "1234", stderr: "", exitCode: 0 };
        }
        if (command.includes("curl -fsSL -X PUT")) {
          return {
            stdout: "\n__HACKERAI_UPLOAD_EXIT_CODE__:56\n",
            stderr: "curl: (56) response ended early",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
    );

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/chart-page-1.png",
        mediaType: "image/png",
      }),
    ).rejects.toThrow(/curl: \(56\) response ended early/);
  });

  test("does not run Windows size fallback for E2B stat failures", async () => {
    const sandbox = makeSandbox(0, true);
    (sandbox.commands.run as jest.Mock).mockResolvedValueOnce({
      stdout: "",
      stderr: "File not found: /home/user/missing.zip\n",
      exitCode: 66,
    });

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/missing.zip",
      }),
    ).rejects.toThrow(/File not found: \/home\/user\/missing\.zip/);

    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"sandbox_generated_file_size_failed"'),
    );
    expect(consoleErrorSpy.mock.calls[0][0]).not.toContain("windows_exit_code");
  });

  test("uses Windows size fallback for Windows Centrifugo sandboxes", async () => {
    const sandbox = makeSandbox(0, false, true);
    (sandbox.commands.run as jest.Mock).mockImplementation(
      async (command: string) => {
        if (command.includes("stat -Lc%s")) {
          return {
            stdout: "",
            stderr: "'[' is not recognized as an internal or external command",
            exitCode: 1,
          };
        }
        if (
          command.startsWith('"%SystemRoot%\\System32\\cmd.exe" /d /v:on /s /c')
        ) {
          return { stdout: "4321", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
    );

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "C:\\Users\\user\\Research & Dev\\report.zip",
    });

    expect(sandbox.commands.run).toHaveBeenNthCalledWith(
      1,
      '"%SystemRoot%\\System32\\cmd.exe" /d /v:on /s /c "for %I in ("!HACKERAI_FILE_SIZE_PATH!") do @echo %~zI"',
      expect.objectContaining({
        displayName: "",
        envVars: expect.objectContaining({
          HACKERAI_FILE_SIZE_PATH:
            "C:\\Users\\user\\Research & Dev\\report.zip",
        }),
      }),
    );
    expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
      "report.zip",
      "application/octet-stream",
      "u1",
      4321,
    );
  });

  test("detects cmd before choosing metadata for a relay without platform info", async () => {
    const sandbox = makeSandbox(0, false, false);
    sandbox.detectShell.mockImplementation(async () => {
      // The real adapter's cached cmd result also makes isWindows() true.
      sandbox.isWindows.mockReturnValue(true);
      return "cmd";
    });
    sandbox.commands.run.mockImplementation(async (command) =>
      command.startsWith('"%SystemRoot%\\System32\\cmd.exe" /d /v:on /s /c')
        ? { stdout: "4321", stderr: "", exitCode: 0 }
        : { stdout: "", stderr: "POSIX syntax is unavailable", exitCode: 1 },
    );
    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "C:\\owned\\report.txt",
    });
    expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
      "report.txt",
      "application/octet-stream",
      "u1",
      4321,
    );
  });

  test("keeps POSIX metadata commands for Git Bash on Windows", async () => {
    const sandbox = makeSandbox(321, false, true);
    sandbox.detectShell.mockResolvedValue("bash");
    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/c/owned/report.txt",
    });
    expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
      "report.txt",
      "application/octet-stream",
      "u1",
      321,
    );
    expect(sandbox.commands.run).toHaveBeenCalledWith(
      expect.stringContaining("stat -Lc%s"),
      expect.any(Object),
    );
    expect(sandbox.commands.run).not.toHaveBeenCalledWith(
      expect.stringContaining('"%SystemRoot%\\System32\\cmd.exe" /d'),
      expect.any(Object),
    );
  });

  test("rejects unsafe Windows size fallback paths before running cmd.exe fallback", async () => {
    const sandbox = makeSandbox(0, false, true);
    (sandbox.commands.run as jest.Mock).mockImplementation(
      async (command: string) => {
        if (command.includes("stat -Lc%s")) {
          return {
            stdout: "",
            stderr: "'[' is not recognized as an internal or external command",
            exitCode: 1,
          };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
    );

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath:
          'C:\\Users\\user\\report" & whoami > C:\\Users\\user\\poc.txt & ".zip',
      }),
    ).rejects.toThrow(/unsupported character/);

    expect(sandbox.commands.run).not.toHaveBeenCalled();
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
  });

  test("derives the file name from Windows-style paths", async () => {
    const sandbox = makeSandbox(1234);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "C:\\Users\\user\\report.txt",
    });

    expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
      "report.txt",
      "application/octet-stream",
      "u1",
      1234,
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "report.txt",
      }),
    );
  });

  test("uploads allowed E2B files from the sandbox without downloading into memory", async () => {
    const sandbox = makeSandbox(4321, true);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/archive.tar.gz",
    });

    expect(sandbox.downloadUrl).not.toHaveBeenCalled();
    expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "curl -fsSL -X PUT -H 'Content-Type: application/octet-stream'",
      ),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    const uploadCommand = (sandbox.commands.run as jest.Mock).mock.calls[1][0];
    expect(uploadCommand).toContain("'https://s3.example/upload'");
    expect(uploadCommand).not.toContain("UPLOAD_URL");
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "archive.tar.gz",
        size: 4321,
      }),
    );
  });
});
