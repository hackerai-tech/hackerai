jest.mock("server-only", () => ({}), { virtual: true });

import type { UIMessage } from "ai";
import {
  getSandboxUploadFailureMetadata,
  prepareLocalDesktopAttachmentsForTrigger,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
  uploadSandboxFiles,
} from "../sandbox-file-utils";

const PRODUCTION_COMMAND_TIMEOUT_MESSAGE =
  "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs' - the total time a long running request (like command execution or directory watch) can be active.";

const makeLocalMessage = (): UIMessage =>
  ({
    id: "m1",
    role: "user",
    parts: [
      { type: "text", text: "inspect this" },
      {
        type: "file",
        storage: "local-desktop",
        localAttachmentId: "local-1",
        localPath: "/Users/alice/Secrets/report.pdf",
        name: "report.pdf",
        mediaType: "application/pdf",
        size: 123,
      },
    ],
  }) as UIMessage;

describe("desktop-local sandbox file helpers", () => {
  it("removes source paths before persistence", () => {
    const [message] = stripLocalDesktopSourcePaths([makeLocalMessage()]);

    const filePart = message.parts?.find((part: any) => part.type === "file");
    expect(filePart).toMatchObject({
      type: "file",
      storage: "local-desktop",
      localAttachmentId: "local-1",
      name: "report.pdf",
    });
    expect((filePart as any).localPath).toBeUndefined();
  });

  it("prepares trigger messages with staged attachment tags but no source path", () => {
    const { messages, sandboxFiles } = prepareLocalDesktopAttachmentsForTrigger(
      [makeLocalMessage()],
      "/tmp/hackerai-upload",
    );

    expect(sandboxFiles).toEqual([
      {
        kind: "localPath",
        path: "/Users/alice/Secrets/report.pdf",
        localPath: "/tmp/hackerai-upload/report.pdf",
      },
    ]);
    expect(JSON.stringify(messages)).not.toContain(
      "/Users/alice/Secrets/report.pdf",
    );
    expect(
      messages[0].parts?.some(
        (part: any) =>
          part.type === "text" &&
          part.text ===
            '<attachment filename="report.pdf" local_path="/tmp/hackerai-upload/report.pdf" />',
      ),
    ).toBe(true);
  });

  it("copies desktop-local files through the local sandbox instead of downloading", async () => {
    const copyLocal = jest.fn().mockResolvedValue(undefined);
    const downloadFromUrl = jest.fn();

    const result = await uploadSandboxFiles(
      [
        {
          kind: "localPath",
          path: "/Users/alice/Secrets/report.pdf",
          localPath: "/tmp/hackerai-upload/report.pdf",
        },
      ],
      async () => ({
        files: { copyLocal, downloadFromUrl },
      }),
    );

    expect(result.failedCount).toBe(0);
    expect(copyLocal).toHaveBeenCalledWith(
      "/Users/alice/Secrets/report.pdf",
      "/tmp/hackerai-upload/report.pdf",
    );
    expect(downloadFromUrl).not.toHaveBeenCalled();
  });

  it("redacts desktop source paths from staging failure logs", async () => {
    const sourcePath = "/Users/alice/Secrets/report.pdf";
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      await uploadSandboxFiles(
        [
          {
            kind: "localPath",
            path: sourcePath,
            localPath: "/tmp/hackerai-upload/report.pdf",
          },
        ],
        async () => ({
          files: {
            copyLocal: jest
              .fn()
              .mockRejectedValue(
                new Error(`Failed to copy ${sourcePath}: permission denied`),
              ),
          },
        }),
      );

      const logged = consoleErrorSpy.mock.calls
        .map((call) => JSON.stringify(call))
        .join("\n");
      expect(logged).not.toContain(sourcePath);
      expect(logged).toContain("[redacted-local-path]");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("redacts source and destination paths from staging failure diagnostics", async () => {
    const sourceUrl =
      "https://storage.example.com/object-key/private-report.pdf?X-Amz-Credential=opaque&X-Amz-Signature=secret";
    const localPath = "/home/user/upload/private-report.pdf";
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: sourceUrl,
            localPath,
          },
        ],
        async () => ({
          files: {
            downloadFromUrl: jest
              .fn()
              .mockRejectedValue(
                new Error(
                  `Failed to download ${sourceUrl} to C:\\sandbox\\private-report.pdf: timed out`,
                ),
              ),
          },
        }),
      );

      const normalizedLogCalls = consoleErrorSpy.mock.calls.map((call) =>
        call.map((value) =>
          value instanceof Error ? { message: value.message } : value,
        ),
      );
      const diagnostics = JSON.stringify({
        logged: normalizedLogCalls,
        metadata: getSandboxUploadFailureMetadata(result),
      });
      expect(diagnostics).not.toContain("X-Amz-Credential");
      expect(diagnostics).not.toContain("X-Amz-Signature");
      expect(diagnostics).not.toContain("opaque");
      expect(diagnostics).not.toContain("secret");
      expect(diagnostics).not.toContain("storage.example.com");
      expect(diagnostics).not.toContain("object-key");
      expect(diagnostics).not.toContain("private-report.pdf");
      expect(diagnostics).not.toContain(localPath);
      expect(diagnostics).toContain("[redacted-url]");
      expect(diagnostics).toContain("[redacted-destination-path]");
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_kind: "url",
        upload_failure_protocol: "https",
        upload_failure_url_length: sourceUrl.length,
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("retries url uploads at a unique writable path when /tmp is not writable", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const downloadFromUrl = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Failed to download file: mkdir: cannot create directory '/tmp/hackerai-upload': Permission denied",
        ),
      )
      .mockResolvedValueOnce(undefined);
    const run = jest.fn().mockResolvedValue({
      exitCode: 0,
      stdout: "/home/alice/hackerai-upload/fallback.a1b2c3/report.pdf",
      stderr: "",
    });

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/report.pdf",
            localPath: "/tmp/hackerai-upload/report.pdf",
          },
        ],
        async () => ({
          commands: { run },
          files: { downloadFromUrl },
        }),
      );

      expect(result).toEqual({
        failedCount: 0,
        pathRewrites: [
          {
            from: "/tmp/hackerai-upload/report.pdf",
            to: "/home/alice/hackerai-upload/fallback.a1b2c3/report.pdf",
          },
        ],
      });
      expect(downloadFromUrl).toHaveBeenCalledWith(
        "https://example.com/report.pdf",
        "/tmp/hackerai-upload/report.pdf",
      );
      expect(downloadFromUrl).toHaveBeenCalledWith(
        "https://example.com/report.pdf",
        "/home/alice/hackerai-upload/fallback.a1b2c3/report.pdf",
      );
      expect(run).toHaveBeenCalledWith(
        expect.stringContaining('dir="$root/fallback-'),
        { displayName: "" },
      );
      expect(run).toHaveBeenCalledWith(
        expect.stringContaining('mkdir "$dir" 2>/dev/null || continue'),
        { displayName: "" },
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("normalizes thrown E2B curl write errors and retries in a writable directory", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const run = jest.fn(async (command: string) => {
      if (command.includes("curl") && command.includes("/home/user/upload")) {
        const error = new Error("exit status 23") as Error & {
          exitCode: number;
          stdout: string;
          stderr: string;
        };
        error.exitCode = 23;
        error.stdout = "";
        error.stderr = "curl: (23) Failure writing output to destination";
        throw error;
      }

      if (command.includes("for base in")) {
        return {
          exitCode: 0,
          stdout: "/tmp/hackerai-upload/fallback.d4e5f6/report.pdf",
          stderr: "",
        };
      }

      if (
        command.includes("curl") &&
        command.includes("/tmp/hackerai-upload")
      ) {
        return { exitCode: 0, stdout: "", stderr: "" };
      }

      if (command.includes("df -h /home/user")) {
        return {
          exitCode: 0,
          stdout: "Filesystem Size Used Avail Use% Mounted on\n",
          stderr: "",
        };
      }

      return { exitCode: 0, stdout: "", stderr: "" };
    });

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/report.pdf",
            localPath: "/home/user/upload/report.pdf",
          },
        ],
        async () => ({
          commands: { run },
        }),
      );
      await jest.advanceTimersByTimeAsync(1_500);
      const result = await pendingResult;

      expect(result).toEqual({
        failedCount: 0,
        pathRewrites: [
          {
            from: "/home/user/upload/report.pdf",
            to: "/tmp/hackerai-upload/fallback.d4e5f6/report.pdf",
          },
        ],
      });

      const homeCurlAttempts = run.mock.calls.filter(([command]) =>
        String(command).includes("-o '/home/user/upload/report.pdf'"),
      );
      const fallbackCurlAttempts = run.mock.calls.filter(([command]) =>
        String(command).includes(
          "-o '/tmp/hackerai-upload/fallback.d4e5f6/report.pdf'",
        ),
      );
      expect(homeCurlAttempts).toHaveLength(3);
      expect(fallbackCurlAttempts).toHaveLength(1);
      expect(
        run.mock.calls.some(([command]) =>
          String(command).includes('dir="$root/fallback-'),
        ),
      ).toBe(true);
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
    }
  });

  it("retries transient E2B command-channel handshake timeouts", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new Error("2: [unknown] Request handshake timed out after 60000ms"),
      )
      .mockRejectedValueOnce(
        new Error("2: [unknown] Request handshake timed out after 60000ms"),
      )
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        async () => ({
          commands: { run },
        }),
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result).toEqual({ failedCount: 0, pathRewrites: [] });
      expect(run).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
    }
  });

  it("retries only after the Desktop command relay reports not subscribed", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Local sandbox connection conn-1 is not subscribed to the command relay.",
        ),
      )
      .mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        async () => ({ commands: { run } }),
      );
      await jest.advanceTimersByTimeAsync(5_000);

      await expect(pendingResult).resolves.toEqual({
        failedCount: 0,
        pathRewrites: [],
      });
      expect(run).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
    }
  });

  it("refreshes the sandbox once after exhausted transient upload command failures", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const firstRun = jest
      .fn()
      .mockRejectedValue(
        new Error("2: [unknown] Request handshake timed out after 60000ms"),
      );
    const refreshedRun = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const ensureSandbox = jest.fn(async (options?: { refresh?: boolean }) => ({
      commands: { run: options?.refresh ? refreshedRun : firstRun },
    }));

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result).toEqual({
        failedCount: 0,
        pathRewrites: [],
        retriedWithFreshSandbox: true,
      });
      expect(firstRun).toHaveBeenCalledTimes(3);
      expect(refreshedRun).toHaveBeenCalledTimes(1);
      expect(ensureSandbox).toHaveBeenCalledTimes(2);
      expect(ensureSandbox.mock.calls[1][0]).toMatchObject({
        refresh: true,
        reason: "attachment_staging_transient_command_failure",
      });
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("refreshes the sandbox after production deadline_exceeded upload command timeouts", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const firstRun = jest
      .fn()
      .mockRejectedValue(new Error(PRODUCTION_COMMAND_TIMEOUT_MESSAGE));
    const refreshedRun = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const ensureSandbox = jest.fn(async (options?: { refresh?: boolean }) => ({
      commands: { run: options?.refresh ? refreshedRun : firstRun },
    }));

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result).toEqual({
        failedCount: 0,
        pathRewrites: [],
        retriedWithFreshSandbox: true,
      });
      expect(firstRun).toHaveBeenCalledTimes(3);
      expect(refreshedRun).toHaveBeenCalledTimes(1);
      expect(ensureSandbox).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it.each([
    [
      "Sandbox operation timed out. The sandbox may be overloaded. Please try again.",
      "operation_timeout",
    ],
    [
      "Failed creating persistent sandbox: The operation was aborted due to timeout",
      "operation_timeout",
    ],
    [
      "Failed creating persistent sandbox: 500: Failed to place sandbox",
      "placement_failure",
    ],
  ])(
    "refreshes once after retryable sandbox acquisition failure %s",
    async (errorMessage, failureReason) => {
      const consoleWarnSpy = jest
        .spyOn(console, "warn")
        .mockImplementation(() => {});
      const consoleInfoSpy = jest
        .spyOn(console, "info")
        .mockImplementation(() => {});
      const downloadFromUrl = jest.fn().mockResolvedValue(undefined);
      const ensureSandbox = jest
        .fn()
        .mockRejectedValueOnce(new Error(errorMessage))
        .mockResolvedValueOnce({ files: { downloadFromUrl } });

      try {
        const result = await uploadSandboxFiles(
          [
            {
              kind: "url",
              url: "https://example.com/screenshot.png",
              localPath: "/home/user/upload/screenshot.png",
            },
          ],
          ensureSandbox,
          {
            retryWithFreshSandboxOnTransientFailure: true,
            logContext: {
              service: "agent-long",
              requestId: "run-123",
              userId: "user-123",
              chatId: "chat-123",
            },
          },
        );

        expect(result).toEqual({
          failedCount: 0,
          pathRewrites: [],
          retriedWithFreshSandbox: true,
        });
        expect(ensureSandbox).toHaveBeenCalledTimes(2);
        expect(ensureSandbox.mock.calls[1][0]).toEqual({
          refresh: true,
          reason: "attachment_staging_sandbox_acquisition_failure",
        });
        expect(downloadFromUrl).toHaveBeenCalledTimes(1);

        const scheduledLog = JSON.parse(
          String(
            consoleWarnSpy.mock.calls.find(([value]) =>
              String(value).includes(
                "sandbox_attachment_acquisition_retry_scheduled",
              ),
            )?.[0],
          ),
        );
        expect(scheduledLog).toMatchObject({
          level: "warn",
          event: "sandbox_attachment_acquisition_retry_scheduled",
          service: "agent-long",
          request_id: "run-123",
          user_id: "user-123",
          chat_id: "chat-123",
          initial_failure_reason: failureReason,
          final_failure_reason: null,
        });
        expect(
          consoleInfoSpy.mock.calls.some(([value]) =>
            String(value).includes("sandbox_attachment_acquisition_recovered"),
          ),
        ).toBe(true);
        expect(JSON.stringify(scheduledLog)).not.toContain(errorMessage);
      } finally {
        consoleWarnSpy.mockRestore();
        consoleInfoSpy.mockRestore();
      }
    },
  );

  it("does not refresh non-retryable sandbox acquisition failures", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const ensureSandbox = jest
      .fn()
      .mockRejectedValue(new Error("Sandbox authentication failed"));

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );

      expect(result.failedCount).toBe(1);
      expect(result.retriedWithFreshSandbox).toBeUndefined();
      expect(ensureSandbox).toHaveBeenCalledTimes(1);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_sandbox_readiness_reason: "unknown",
      });
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("keeps sandbox acquisition recovery opt-in for alternate callers", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const ensureSandbox = jest
      .fn()
      .mockRejectedValue(new Error("Sandbox operation timed out"));

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
      );

      expect(result.failedCount).toBe(1);
      expect(result.retriedWithFreshSandbox).toBeUndefined();
      expect(ensureSandbox).toHaveBeenCalledTimes(1);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("records the bounded final reason when sandbox acquisition retry fails", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const ensureSandbox = jest
      .fn()
      .mockRejectedValueOnce(new Error("Sandbox operation timed out"))
      .mockRejectedValueOnce(new Error("500: Failed to place sandbox"));

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );

      expect(result.failedCount).toBe(1);
      expect(ensureSandbox).toHaveBeenCalledTimes(2);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_sandbox_readiness_reason: "placement_failure",
        upload_retried_with_fresh_sandbox: true,
      });
      const retryFailedLog = JSON.parse(
        String(
          consoleErrorSpy.mock.calls.find(([value]) =>
            String(value).includes(
              "sandbox_attachment_acquisition_retry_failed",
            ),
          )?.[0],
        ),
      );
      expect(retryFailedLog).toMatchObject({
        initial_failure_reason: "operation_timeout",
        final_failure_reason: "placement_failure",
      });
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("uses one operation-wide refresh across acquisition and staging", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValue(
        new Error("2: [unknown] Request handshake timed out after 60000ms"),
      );
    const ensureSandbox = jest
      .fn()
      .mockRejectedValueOnce(new Error("Sandbox operation timed out"))
      .mockResolvedValue({ commands: { run } });

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result.failedCount).toBe(1);
      expect(result.retriedWithFreshSandbox).toBe(true);
      expect(ensureSandbox).toHaveBeenCalledTimes(2);
      expect(run).toHaveBeenCalledTimes(3);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_transient_sandbox_command: true,
        upload_retried_with_fresh_sandbox: true,
      });
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("returns redacted metadata for transient upload command failures", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValue(
        new Error("2: [unknown] Request handshake timed out after 60000ms"),
      );

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png?X-Amz-Signature=secret",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        async () => ({
          commands: { run },
        }),
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result.failedCount).toBe(1);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_kind: "url",
        upload_failure_transient_sandbox_command: true,
        upload_failure_protocol: "https",
      });
      expect(
        String(getSandboxUploadFailureMetadata(result)?.upload_failure_cause),
      ).toContain("Request handshake timed out");
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("marks production deadline_exceeded upload command timeouts as transient", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValue(new Error(PRODUCTION_COMMAND_TIMEOUT_MESSAGE));

    try {
      const pendingResult = uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png?X-Amz-Signature=secret",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        async () => ({
          commands: { run },
        }),
      );
      await jest.advanceTimersByTimeAsync(5_000);
      const result = await pendingResult;

      expect(result.failedCount).toBe(1);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_kind: "url",
        upload_failure_transient_sandbox_command: true,
        upload_failure_protocol: "https",
      });
      expect(
        String(getSandboxUploadFailureMetadata(result)?.upload_failure_cause),
      ).toContain("[deadline_exceeded]");
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it.each([
    [28, "curl: (28) ETIMEDOUT"],
    [35, "curl: (35) SSL connect error: Connection reset by peer"],
  ])(
    "does not refresh the sandbox for wrapped curl exit %i",
    async (exitCode, stderr) => {
      const consoleErrorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const run = jest.fn(async (command: string) => {
        if (command.includes("df -h /home/user")) {
          return {
            exitCode: 0,
            stdout: "Filesystem Size Used Avail Use% Mounted on\n",
            stderr: "",
          };
        }

        return { exitCode, stdout: "", stderr };
      });
      const ensureSandbox = jest.fn(async () => ({
        commands: { run },
      }));

      try {
        const result = await uploadSandboxFiles(
          [
            {
              kind: "url",
              url: "https://example.com/screenshot.png",
              localPath: "/home/user/upload/screenshot.png",
            },
          ],
          ensureSandbox,
          { retryWithFreshSandboxOnTransientFailure: true },
        );

        expect(result.failedCount).toBe(1);
        expect(ensureSandbox).toHaveBeenCalledTimes(1);
        expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
          upload_failure_kind: "url",
          upload_failure_transient_sandbox_command: false,
          upload_failure_sandbox_readiness_reason: "unknown",
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
  );

  it("blocks internal URL downloads before invoking the sandbox", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const downloadFromUrl = jest.fn();

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "http://169.254.169.254/latest/meta-data",
            localPath: "/home/user/upload/meta-data",
          },
        ],
        async () => ({
          files: { downloadFromUrl },
        }),
      );

      expect(result.failedCount).toBe(1);
      expect(downloadFromUrl).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("rewrites attachment tags after upload path fallback", () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "text",
            text: '<attachment filename="report.pdf" local_path="/tmp/hackerai-upload/report.pdf" />',
          },
        ],
      },
    ] as UIMessage[];

    const rewritten = rewriteSandboxFilePathsInMessages(messages, [
      {
        from: "/tmp/hackerai-upload/report.pdf",
        to: "/home/alice/hackerai-upload/report.pdf",
      },
    ]);

    expect(rewritten[0].parts?.[0]).toMatchObject({
      text: '<attachment filename="report.pdf" local_path="/home/alice/hackerai-upload/report.pdf" />',
    });
  });
});
