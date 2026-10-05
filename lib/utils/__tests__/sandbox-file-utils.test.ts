jest.mock("server-only", () => ({}), { virtual: true });

import type { UIMessage } from "ai";
import { phLogger } from "@/lib/posthog/server";
import {
  collectSandboxFiles,
  getSandboxUploadFailureMetadata,
  getSandboxUploadUserMessage,
  prepareLocalDesktopAttachmentsForTrigger,
  recoverProviderVisibleImagesAfterSandboxUploadFailure,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
  uploadSandboxFiles,
} from "../sandbox-file-utils";

const PRODUCTION_COMMAND_TIMEOUT_MESSAGE =
  "[deadline_exceeded] the operation timed out: This error is likely due to exceeding 'timeoutMs' - the total time a long running request (like command execution or directory watch) can be active.";
const LOCAL_COMMAND_NO_RESPONSE_MESSAGE =
  "Command timeout after 35000ms [connected: 417ms, subscribed: 417ms, published: 613ms, firstMsg: no] connectionId=conn-unresponsive";

it.each([
  "E2BAcquisitionError",
  "MiosaWorkspaceUnavailableError",
  "CloudMigrationUnavailableError",
  "private-error-name",
])(
  "retains bounded acquisition diagnostics for %s without retrying",
  async (name) => {
    const ensureSandbox = jest.fn().mockRejectedValue(
      Object.assign(new Error("Cloud workspace temporarily unavailable."), {
        name,
      }),
    );
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      const result = await uploadSandboxFiles(
        [1, 2].map((index) => ({
          kind: "url" as const,
          url: `https://example.com/${index}?token=private-token`,
          localPath: `/tmp/private-file-${index}`,
        })),
        ensureSandbox,
        { retryWithFreshSandboxOnTransientFailure: true },
      );
      expect(result.failedCount).toBe(2);
      expect(result.pathRewrites).toEqual([]);
      expect(ensureSandbox).toHaveBeenCalledTimes(1);
      const metadata = getSandboxUploadFailureMetadata(result);
      expect(metadata).toMatchObject({
        upload_failure_phase: "acquisition",
        upload_failure_reason: "unknown",
        upload_failure_sandbox_readiness_reason: "unknown",
      });
      if (name === "private-error-name") {
        expect(metadata).not.toHaveProperty("upload_failure_error_name");
      } else {
        expect(metadata).toHaveProperty("upload_failure_error_name", name);
      }
      expect(JSON.stringify(metadata)).not.toMatch(
        /private-token|private-file|private-error-name/,
      );
      expect(getSandboxUploadUserMessage(result)).toBe(
        "Failed to upload 2 attachments to the computer. Please try again.",
      );
    } finally {
      errorSpy.mockRestore();
    }
  },
);

it("records safe validation fields for a Miosa attachment rejection without retrying it", async () => {
  const error = Object.assign(new Error("Provider rejected the request"), {
    name: "ValidationError",
    status: 422,
    code: "UNKNOWN_ERROR",
    requestId: "request-attachment",
    retryable: false,
    details: {
      errors: [
        {
          loc: ["body", "command"],
          input: "private command",
          msg: "private message",
        },
      ],
    },
  });
  const run = jest.fn().mockRejectedValue(error);
  const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});
  const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  try {
    const result = await uploadSandboxFiles(
      [
        {
          kind: "url",
          url: "https://example.com/file?token=private-token",
          localPath: "/home/user/upload/private-file",
        },
      ],
      async () => ({ sandboxKind: "miosa", commands: { run } }),
      {
        logContext: {
          service: "agent-long",
          requestId: "run-test",
          userId: "user-test",
        },
      },
    );
    expect(result.failedCount).toBe(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_failed",
      expect.objectContaining({
        error_request_id: "request-attachment",
        validation_fields: ["command"],
        failure_stage: "transfer",
        transfer_operation: "download_url",
      }),
    );
    expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
      upload_failure_phase: "transfer",
      upload_failure_validation_fields: ["command"],
    });
    expect(JSON.stringify(eventSpy.mock.calls)).not.toMatch(
      /private-token|private-file|private command|private message/,
    );
  } finally {
    eventSpy.mockRestore();
    errorSpy.mockRestore();
  }
});

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
  it("marks historical desktop sources without queueing them again", () => {
    const previous = makeLocalMessage();
    const followup = {
      id: "followup",
      role: "user",
      parts: [{ type: "text", text: "continue" }],
    } as UIMessage;
    const original = JSON.stringify(previous);
    const { messages, sandboxFiles } = prepareLocalDesktopAttachmentsForTrigger(
      [previous, followup],
    );

    expect(sandboxFiles).toEqual([]);
    expect(JSON.stringify(messages)).toContain(
      'staging=\\"not_requested_this_run\\"',
    );
    expect(JSON.stringify(messages)).not.toContain("/Users/alice/Secrets");
    expect(JSON.stringify(previous)).toBe(original);
  });

  it("marks an old inline image as unstaged while queueing only the current input", () => {
    const messages = [
      {
        id: "old",
        role: "user",
        parts: [
          {
            type: "file",
            fileId: "image_old",
            url: "https://storage.example/old.png",
            filename: "old.png",
          },
        ],
      },
      {
        id: "new",
        role: "user",
        parts: [
          {
            type: "file",
            fileId: "image_new",
            url: "https://storage.example/new.png",
            filename: "new.png",
          },
        ],
      },
    ] as UIMessage[];
    const sandboxFiles: Parameters<typeof collectSandboxFiles>[1] = [];
    collectSandboxFiles(messages, sandboxFiles, undefined, {
      getAttachmentTagKind: () => "inline-image",
    });

    expect(sandboxFiles).toHaveLength(1);
    expect(sandboxFiles[0]).toMatchObject({
      url: "https://storage.example/new.png",
    });
    const oldTag = messages[0].parts.find((part) => part.type === "text");
    expect(oldTag).toMatchObject({
      text: expect.stringContaining('staging="not_requested_this_run"'),
    });
    expect(oldTag).toMatchObject({
      text: expect.stringContaining('already_visible_to_model="true"'),
    });
  });

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

    expect(sandboxFiles).toHaveLength(1);
    expect(sandboxFiles[0]).toMatchObject({
      kind: "localPath",
      path: "/Users/alice/Secrets/report.pdf",
    });
    expect(sandboxFiles[0].localPath).toMatch(
      /^\/tmp\/hackerai-upload\/[a-f0-9]{64}\/report\.pdf$/,
    );
    expect(JSON.stringify(messages)).not.toContain(
      "/Users/alice/Secrets/report.pdf",
    );
    expect(
      messages[0].parts?.some(
        (part: any) =>
          part.type === "text" &&
          part.text ===
            `<attachment filename="report.pdf" local_path="${sandboxFiles[0].localPath}" staging="requested_this_run" />`,
      ),
    ).toBe(true);
  });

  it("gives same-named desktop attachments distinct stable sandbox paths", () => {
    const first = makeLocalMessage();
    const second = {
      ...first.parts?.[1],
      localPath: "/Users/alice/Other/report.pdf",
    };
    first.parts?.push(second as never);

    const { messages, sandboxFiles } = prepareLocalDesktopAttachmentsForTrigger(
      [first],
      "/tmp/hackerai-upload",
    );

    expect(sandboxFiles).toHaveLength(2);
    expect(new Set(sandboxFiles.map((file) => file.localPath)).size).toBe(2);
    expect(
      sandboxFiles.every((file) => file.localPath.endsWith("/report.pdf")),
    ).toBe(true);
    const tags = messages[0].parts?.filter(
      (part: any) => part.type === "text" && part.text.includes("<attachment"),
    );
    expect(tags?.[0]).toEqual({
      type: "text",
      text: sandboxFiles
        .map(
          (file) =>
            `<attachment filename="report.pdf" local_path="${file.localPath}" staging="requested_this_run" />`,
        )
        .join("\n"),
    });
  });

  it("keeps historical same-named stored attachments on distinct paths", () => {
    const messages = [
      {
        id: "old-message",
        role: "user",
        parts: [
          {
            type: "file",
            fileId: "file-old",
            url: "https://storage.example/old-report.pdf",
            name: "report.pdf",
          },
        ],
      },
      {
        id: "new-message",
        role: "user",
        parts: [
          {
            type: "file",
            fileId: "file-new",
            url: "https://storage.example/new-report.pdf",
            name: "report.pdf",
          },
        ],
      },
    ] as UIMessage[];
    const sandboxFiles: Parameters<typeof collectSandboxFiles>[1] = [];

    collectSandboxFiles(messages, sandboxFiles, "/home/user/upload");

    expect(sandboxFiles).toHaveLength(1);
    const oldTag = (messages[0].parts?.[1] as { text: string }).text;
    const newTag = (messages[1].parts?.[1] as { text: string }).text;
    const oldPath = oldTag.match(/local_path="([^"]+)"/)?.[1];
    const newPath = newTag.match(/local_path="([^"]+)"/)?.[1];
    expect(oldPath).toMatch(
      /^\/home\/user\/upload\/[a-f0-9]{64}\/report\.pdf$/,
    );
    expect(oldTag).toContain(
      'legacy_fallback_path="/home/user/upload/report.pdf"',
    );
    expect(oldTag).toContain(
      'use_legacy_fallback_only_if_primary_missing="true"',
    );
    expect(newPath).toBe(sandboxFiles[0].localPath);
    expect(newPath).not.toBe(oldPath);
    expect(newTag).not.toContain("legacy_fallback_path");
    expect(oldTag).toContain('staging="not_requested_this_run"');
    expect(newTag).toContain('staging="requested_this_run"');
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

  it("logs the final copy exit status when the fallback upload path also fails", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const copyLocal = jest
      .fn()
      .mockRejectedValueOnce(
        Object.assign(
          new Error("Failed to prepare local file: permission denied"),
          { exitCode: 1 },
        ),
      )
      .mockRejectedValueOnce(
        Object.assign(
          new Error("Failed to prepare local file: source missing"),
          { exitCode: 2 },
        ),
      );
    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "localPath",
            path: "/private/report.pdf",
            localPath: "/tmp/hackerai-upload/report.pdf",
          },
        ],
        async () => ({
          files: { copyLocal },
          commands: {
            run: jest.fn().mockResolvedValue({
              exitCode: 0,
              stdout: "/home/alice/hackerai-upload/fallback/report.pdf",
              stderr: "",
            }),
          },
        }),
      );
      expect(copyLocal).toHaveBeenCalledTimes(2);
      expect(result.failedCount).toBe(1);
      expect(result.pathRewrites).toEqual([]);
      expect(
        JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0])),
      ).toMatchObject({
        event: "sandbox_attachment_staging_failed",
        failure_exit_code: 2,
      });
      expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
        "report.pdf",
      );
    } finally {
      consoleErrorSpy.mockRestore();
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
      expect(homeCurlAttempts).toHaveLength(1);
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

  it.each([
    ["No space left on device", "attachment_disk_full", "Free some disk space"],
    ["Permission denied", "attachment_permission_denied", "permissions"],
    ["Read-only file system", "attachment_permission_denied", "permissions"],
    [
      "Failure writing output to destination",
      "attachment_write_failed",
      "disk space",
    ],
  ])(
    "preserves %s when the writable-directory probe throws",
    async (stderr, reason, guidance) => {
      const errorSpy = jest
        .spyOn(console, "error")
        .mockImplementation(() => {});
      const run = jest.fn(async (command: string) => {
        if (command.startsWith("curl")) {
          throw Object.assign(new Error("exit status 23"), {
            exitCode: 23,
            stderr: `curl: (23) ${stderr}`,
            stdout: "",
          });
        }
        if (command.includes("for base in")) {
          throw Object.assign(new Error("exit status 1"), { exitCode: 1 });
        }
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      try {
        const result = await uploadSandboxFiles(
          [
            {
              kind: "url",
              url: "https://storage.example.com/private.zip?token=secret",
              localPath: "/home/user/upload/private.zip",
            },
          ],
          async () => ({ commands: { run } }),
        );
        expect(result.failedCount).toBe(1);
        expect(result.failureDetails?.[0]).toMatchObject({
          reason,
          exitCode: 23,
        });
        expect(getSandboxUploadUserMessage(result)).toContain(guidance);
        expect(
          run.mock.calls.filter(([command]) => command.startsWith("curl")),
        ).toHaveLength(1);
        expect(JSON.stringify(errorSpy.mock.calls)).not.toMatch(
          /private.zip|token=secret/,
        );
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it("preserves cancellation during the fallback-directory probe", async () => {
    const controller = new AbortController();
    const stop = new Error("user stopped");
    const downloadFromUrl = jest
      .fn()
      .mockRejectedValue(new Error("curl: (23) Permission denied"));
    const run = jest.fn(async () => {
      controller.abort(stop);
      throw new Error("exit status 1");
    });
    await expect(
      uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/file",
            localPath: "/home/user/upload/file",
          },
        ],
        async () => ({ commands: { run }, files: { downloadFromUrl } }),
        { signal: controller.signal },
      ),
    ).rejects.toBe(stop);
  });

  it.each([
    "ENOSPC: no space left on device",
    "Failed to prepare local file: disk quota exceeded",
  ])("reports local attachment disk exhaustion: %s", async (message) => {
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const copyLocal = jest.fn().mockRejectedValue(new Error(message));
    const run = jest.fn().mockRejectedValue(new Error("exit status 1"));
    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "localPath",
            path: "/private/report.txt",
            localPath: "/tmp/hackerai-upload/report.txt",
          },
        ],
        async () => ({ commands: { run }, files: { copyLocal } }),
      );
      expect(result.failureDetails?.[0].reason).toBe("attachment_disk_full");
      expect(getSandboxUploadUserMessage(result)).toContain(
        "Free some disk space",
      );
      expect(copyLocal).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
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

  it("quarantines an unresponsive local connection before reacquiring the sandbox", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const firstRun = jest
      .fn()
      .mockRejectedValue(new Error(LOCAL_COMMAND_NO_RESPONSE_MESSAGE));
    const refreshedRun = jest
      .fn()
      .mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
    const ensureSandbox = jest.fn(async (options?: { refresh?: boolean }) => ({
      commands: { run: options?.refresh ? refreshedRun : firstRun },
      getConnectionId: () => "conn-unresponsive",
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

      expect(result.failedCount).toBe(0);
      expect(ensureSandbox).toHaveBeenCalledTimes(2);
      expect(ensureSandbox.mock.calls[1][0]).toEqual({
        refresh: true,
        reason: "attachment_staging_transient_command_failure",
        excludeConnectionId: "conn-unresponsive",
      });
    } finally {
      jest.useRealTimers();
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("preserves the no-response cause when connection quarantine blocks reacquisition", async () => {
    jest.useFakeTimers();
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const run = jest
      .fn()
      .mockRejectedValue(new Error(LOCAL_COMMAND_NO_RESPONSE_MESSAGE));
    const ensureSandbox = jest
      .fn()
      .mockResolvedValueOnce({
        commands: { run },
        getConnectionId: () => "conn-unresponsive",
      })
      .mockRejectedValueOnce(new Error("Selected connection is unavailable"));

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
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_reason: "local_command_no_response",
        upload_failure_transient_sandbox_command: true,
        upload_retried_with_fresh_sandbox: true,
      });
      expect(getSandboxUploadUserMessage(result)).toContain(
        "Reconnect it in Remote Control",
      );
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
      "fresh_sandbox",
    ],
    [
      "Failed creating persistent sandbox: The operation was aborted due to timeout",
      "operation_timeout",
      "fresh_sandbox",
    ],
    [
      "Failed creating persistent sandbox: 500: Failed to place sandbox",
      "placement_failure",
      "fresh_sandbox",
    ],
  ])(
    "refreshes once after retryable sandbox acquisition failure %s",
    async (errorMessage, failureReason, recoveryStrategy) => {
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
          recovery_strategy: recoveryStrategy,
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

  it("records safe Miosa diagnostics for attachment staging failures", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});
    const providerError = Object.assign(
      new Error("Sandbox transport failed for private attachment content"),
      {
        name: "MiosaError",
        code: "FILE_TRANSPORT_UNAVAILABLE",
        status: 503,
        requestId: "request-safe-123",
        retryable: true,
      },
    );

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/private-report.pdf?signature=secret",
            localPath: "/home/user/upload/private-report.pdf",
          },
        ],
        async () => ({
          sandboxKind: "miosa",
          commands: { run: jest.fn().mockRejectedValue(providerError) },
        }),
        {
          logContext: {
            service: "agent-long",
            requestId: "run-safe-123",
            userId: "user-safe-123",
            chatId: "chat-safe-123",
          },
        },
      );

      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_sandbox_provider: "miosa",
        upload_failure_error_name: "MiosaError",
        upload_failure_error_code: "FILE_TRANSPORT_UNAVAILABLE",
        upload_failure_error_http_status: 503,
        upload_failure_error_request_id: "request-safe-123",
        upload_failure_error_retryable: true,
      });
      const structuredLog = JSON.parse(
        String(consoleErrorSpy.mock.calls[0]?.[0]),
      );
      expect(structuredLog).toMatchObject({
        event: "sandbox_attachment_staging_failed",
        sandbox_provider: "miosa",
        error_code: "FILE_TRANSPORT_UNAVAILABLE",
        error_http_status: 503,
        error_request_id: "request-safe-123",
        error_retryable: true,
      });
      expect(JSON.stringify(structuredLog)).not.toContain("private-report");
      expect(JSON.stringify(structuredLog)).not.toContain("signature=secret");
      expect(eventSpy).toHaveBeenCalledWith(
        "sandbox_attachment_staging_failed",
        expect.objectContaining({
          sandbox_provider: "miosa",
          error_code: "FILE_TRANSPORT_UNAVAILABLE",
          error_request_id: "request-safe-123",
        }),
      );
    } finally {
      consoleErrorSpy.mockRestore();
      eventSpy.mockRestore();
    }
  });

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
        upload_failure_reason: "sandbox_placement_failure",
        upload_failure_sandbox_readiness_reason: "placement_failure",
        upload_retried_with_fresh_sandbox: true,
      });
      const retryFailedLog = JSON.parse(
        String(
          consoleWarnSpy.mock.calls.find(([value]) =>
            String(value).includes(
              "sandbox_attachment_acquisition_retry_failed",
            ),
          )?.[0],
        ),
      );
      expect(retryFailedLog).toMatchObject({
        level: "warn",
        initial_failure_reason: "operation_timeout",
        final_failure_reason: "placement_failure",
        recovery_strategy: "fresh_sandbox",
      });
    } finally {
      consoleWarnSpy.mockRestore();
      consoleErrorSpy.mockRestore();
    }
  });

  it("retries placement recovery with a fresh configured-provider sandbox", async () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const ensureSandbox = jest
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "Failed creating persistent sandbox: 500: Failed to place sandbox",
        ),
      )
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

      expect(ensureSandbox).toHaveBeenCalledTimes(2);
      expect(ensureSandbox.mock.calls[1][0]).toEqual({
        refresh: true,
        reason: "attachment_staging_sandbox_acquisition_failure",
      });
      expect(result.retriedWithFreshSandbox).toBe(true);
      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_reason: "sandbox_placement_failure",
        upload_failure_sandbox_readiness_reason: "placement_failure",
      });
    } finally {
      consoleWarnSpy.mockRestore();
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
        upload_failure_reason: "command_channel_failure",
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
        upload_failure_reason: "command_channel_failure",
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
    [28, "curl: (28) ETIMEDOUT", "attachment_download_timeout"],
    [
      35,
      "curl: (35) SSL connect error: Connection reset by peer",
      "attachment_transfer_failed",
    ],
  ])(
    "does not refresh the sandbox for wrapped curl exit %i",
    async (exitCode, stderr, failureReason) => {
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
          upload_failure_reason: failureReason,
          upload_failure_transient_sandbox_command: false,
          upload_failure_sandbox_readiness_reason: "unknown",
        });
        expect(
          JSON.parse(String(consoleErrorSpy.mock.calls[0]?.[0])),
        ).toMatchObject({
          event: "sandbox_attachment_staging_failed",
          failure_exit_code: exitCode,
        });
      } finally {
        consoleErrorSpy.mockRestore();
      }
    },
  );

  it("classifies Windows command parsing failures separately", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const downloadFromUrl = jest
      .fn()
      .mockRejectedValue(
        new Error(
          "Failed to download file: The syntax of the command is incorrect. 'X-Amz-Signature' is not recognized as an internal or external command.",
        ),
      );

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "url",
            url: "https://example.com/screenshot.png?X-Amz-Signature=secret",
            localPath: "C:\\temp\\hackerai-upload\\screenshot.png",
          },
        ],
        async () => ({ files: { downloadFromUrl } }),
      );

      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_reason: "windows_command_syntax",
        upload_failure_transient_sandbox_command: false,
      });
      expect(getSandboxUploadUserMessage(result)).toContain(
        "selected Windows computer",
      );
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it("logs bounded context for local attachment preparation failures", async () => {
    const consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const sourcePath = "C:\\Users\\alice\\private-report.pdf";

    try {
      const result = await uploadSandboxFiles(
        [
          {
            kind: "localPath",
            path: sourcePath,
            localPath: "/tmp/hackerai-upload/private-report.pdf",
          },
        ],
        async () => ({
          files: {
            copyLocal: jest
              .fn()
              .mockRejectedValue(
                Object.assign(
                  new Error(
                    `Failed to prepare local file: cannot read ${sourcePath}`,
                  ),
                  { exitCode: 1 },
                ),
              ),
          },
        }),
        {
          logContext: {
            service: "hackerai-web",
            requestId: "request-1",
            userId: "user-1",
            chatId: "chat-1",
          },
        },
      );

      expect(getSandboxUploadFailureMetadata(result)).toMatchObject({
        upload_failure_reason: "local_file_prepare_failed",
      });
      const structuredLog = JSON.parse(
        String(consoleErrorSpy.mock.calls[0]?.[0]),
      );
      expect(structuredLog).toMatchObject({
        event: "sandbox_attachment_staging_failed",
        service: "hackerai-web",
        request_id: "request-1",
        user_id: "user-1",
        chat_id: "chat-1",
        failed_count: 1,
        total_count: 1,
        failure_reason: "local_file_prepare_failed",
        failure_exit_code: 1,
      });
      expect(JSON.stringify(structuredLog)).not.toContain(sourcePath);
      expect(JSON.stringify(structuredLog)).not.toContain("private-report.pdf");
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

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

  it("keeps provider-visible images when cloud staging is unavailable", () => {
    const consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "https://storage.example/screenshot.png",
            mediaType: "image/png",
            name: "screenshot.png",
          },
          {
            type: "text",
            text: '<inline_image_attachment filename="screenshot.png" sandbox_path="/home/user/upload/screenshot.png" already_visible_to_model="true" use_sandbox_path_for="file_operations_only" />',
          },
        ],
      },
    ] as UIMessage[];

    try {
      const recovered = recoverProviderVisibleImagesAfterSandboxUploadFailure(
        messages,
        [
          {
            kind: "url",
            url: "https://storage.example/screenshot.png",
            localPath: "/home/user/upload/screenshot.png",
          },
        ],
        {
          failedCount: 1,
          pathRewrites: [],
          failureDetails: [
            {
              kind: "url",
              error: "sandbox placement failed",
              reason: "sandbox_placement_failure",
              transientSandboxCommand: false,
              sandboxReadinessReason: "placement_failure",
            },
          ],
        },
        {
          service: "agent-long",
          requestId: "run-1",
          userId: "user-1",
          chatId: "chat-1",
        },
      );

      expect(recovered).not.toBeNull();
      expect(recovered?.[0].parts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "file",
            url: "https://storage.example/screenshot.png",
          }),
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining('images_visible_inline="true"'),
          }),
        ]),
      );
      expect(JSON.stringify(recovered)).not.toContain(
        "/home/user/upload/screenshot.png",
      );
      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("sandbox_image_attachment_staging_bypassed"),
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("does not bypass failed staging for non-image attachments", () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [
          {
            type: "file",
            url: "https://storage.example/report.pdf",
            mediaType: "application/pdf",
            name: "report.pdf",
          },
        ],
      },
    ] as UIMessage[];

    expect(
      recoverProviderVisibleImagesAfterSandboxUploadFailure(
        messages,
        [
          {
            kind: "url",
            url: "https://storage.example/report.pdf",
            localPath: "/home/user/upload/report.pdf",
          },
        ],
        { failedCount: 1, pathRewrites: [] },
        {
          service: "chat-handler",
          userId: "user-1",
          chatId: "chat-1",
        },
      ),
    ).toBeNull();
  });

  it("does not bypass a partial batch upload failure", () => {
    const imageFiles = [
      {
        kind: "url" as const,
        url: "https://storage.example/one.png",
        localPath: "/home/user/upload/one.png",
      },
      {
        kind: "url" as const,
        url: "https://storage.example/two.png",
        localPath: "/home/user/upload/two.png",
      },
    ];

    expect(
      recoverProviderVisibleImagesAfterSandboxUploadFailure(
        [],
        imageFiles,
        { failedCount: 1, pathRewrites: [] },
        {
          service: "agent-long",
          userId: "user-1",
          chatId: "chat-1",
        },
      ),
    ).toBeNull();
  });
});

describe("attachment write fallback observability", () => {
  const context = {
    service: "agent-long" as const,
    requestId: "run-diagnostics",
    userId: "user-test",
    chatId: "chat-test",
    environment: "PREVIEW",
    release: "20261001.1",
  };
  const probeOutput = JSON.stringify({
    probe_status: "ok",
    command_uid: 1000,
    command_gid: 1000,
    target_exists: true,
    target_uid: 0,
    target_mode: 0o400,
    target_writable: false,
    available_bytes: 10000,
    available_inodes: 42,
    filesystem_read_only: false,
    write_probe_result: "writable",
    private_filename: "DO_NOT_LOG",
  });
  let eventSpy: jest.SpyInstance;
  let warnSpy: jest.SpyInstance;
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  beforeEach(() => {
    eventSpy = jest.spyOn(phLogger, "event").mockImplementation(() => {});
    warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    infoSpy = jest.spyOn(console, "info").mockImplementation(() => {});
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    eventSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
    errorSpy.mockRestore();
  });
  const makeSandbox = (finalFailure = false, probeFailure = false) => ({
    sandboxId: "e2b-test-sandbox",
    commands: {
      run: jest.fn(async (command: string) => {
        if (command.startsWith("timeout --kill-after=1s 3s python3")) {
          if (probeFailure) throw new Error("probe timeout");
          return { exitCode: 0, stdout: probeOutput, stderr: "" };
        }
        if (command.includes("for base in"))
          return {
            exitCode: 0,
            stdout: "/tmp/hackerai-upload/fallback/test.pdf",
            stderr: "",
          };
        if (
          command.startsWith("curl") &&
          (command.includes("/home/user/upload") || finalFailure)
        )
          throw Object.assign(new Error("curl: (23) Failure writing output"), {
            exitCode: 23,
            stderr: "curl: (23) Failure writing output",
          });
        return { exitCode: 0, stdout: "", stderr: "" };
      }),
    },
  });
  const file = {
    kind: "url" as const,
    url: "https://private.example/private.pdf?X-Amz-Signature=DO_NOT_LOG",
    localPath: "/home/user/upload/private.pdf",
  };

  it("retains the initial reason and reports recovered uploads without analytics sandbox IDs or private paths", async () => {
    const sandbox = makeSandbox();
    const result = await uploadSandboxFiles([file], async () => sandbox, {
      logContext: context,
    });
    expect(result.failedCount).toBe(0);
    expect(result.pathRewrites).toHaveLength(1);
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_fallback",
      expect.objectContaining({
        initial_failure_reason: "attachment_write_failed",
        initial_failure_exit_code: 23,
        fallback_outcome: "recovered",
        diagnostics_target_uid: 0,
        diagnostics_target_writable: false,
        diagnostics_write_probe_result: "writable",
        release: context.release,
        environment: "PREVIEW",
        trigger_run_id: context.requestId,
        staging_attempt: "initial",
      }),
    );
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_completed",
      expect.objectContaining({
        total_count: 1,
        recovered_count: 1,
        failed_count: 0,
        direct_success_count: 0,
      }),
    );
    const logs = JSON.stringify([
      warnSpy.mock.calls,
      infoSpy.mock.calls,
      errorSpy.mock.calls,
    ]);
    expect(logs).toContain("e2b-test-sandbox");
    expect(logs).not.toMatch(
      /private\.pdf|private\.example|X-Amz|DO_NOT_LOG|\/home\/user|\/tmp/,
    );
    expect(JSON.stringify(eventSpy.mock.calls)).not.toMatch(
      /sandbox_id|e2b-test-sandbox|DO_NOT_LOG|private\.pdf/,
    );
  });

  it("reports unsuccessful fallback even if the best-effort probe fails", async () => {
    const result = await uploadSandboxFiles(
      [file],
      async () => makeSandbox(true, true),
      { logContext: context },
    );
    expect(result.failedCount).toBe(1);
    expect(result.failureDetails?.[0]).toMatchObject({
      exitCode: 23,
      reason: "attachment_write_failed",
    });
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_fallback",
      expect.objectContaining({
        initial_failure_exit_code: 23,
        final_failure_exit_code: 23,
        fallback_outcome: "failed",
        diagnostics_probe_status: "unavailable",
      }),
    );
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_completed",
      expect.objectContaining({
        total_count: 1,
        failed_count: 1,
        recovered_count: 0,
      }),
    );
  });

  it("caps E2B probes at three per staging attempt during simultaneous failures", async () => {
    const sandbox = makeSandbox();
    const files = Array.from({ length: 5 }, (_, i) => ({
      ...file,
      localPath: `/home/user/upload/file-${i}`,
    }));
    const result = await uploadSandboxFiles(files, async () => sandbox, {
      logContext: context,
    });
    expect(result.failedCount).toBe(0);
    expect(
      sandbox.commands.run.mock.calls.filter(([command]) =>
        command.startsWith("timeout --kill-after=1s 3s python3"),
      ),
    ).toHaveLength(3);
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_fallback",
      expect.objectContaining({
        fallback_outcome: "recovered",
        diagnostics_probe_status: "budget_exhausted",
      }),
    );
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_completed",
      expect.objectContaining({
        total_count: 5,
        recovered_count: 5,
        failed_count: 0,
      }),
    );
  });

  it("does not probe or emit fallback diagnostics for healthy uploads", async () => {
    const sandbox = {
      sandboxId: "e2b-test-sandbox",
      commands: {
        run: jest.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
      },
    };
    await uploadSandboxFiles([file], async () => sandbox, {
      logContext: context,
    });
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledTimes(1);
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_completed",
      expect.objectContaining({
        total_count: 1,
        recovered_count: 0,
        direct_success_count: 1,
      }),
    );
  });

  it("skips E2B filesystem diagnostics on the MIOSA adapter", async () => {
    const sandbox = { ...makeSandbox(), sandboxKind: "miosa" };
    await uploadSandboxFiles([file], async () => sandbox, {
      logContext: context,
    });
    expect(
      sandbox.commands.run.mock.calls.some(([command]) =>
        command.startsWith("timeout --kill-after=1s 3s python3"),
      ),
    ).toBe(false);
    expect(eventSpy).toHaveBeenCalledWith(
      "sandbox_attachment_staging_fallback",
      expect.objectContaining({
        sandbox_provider: "miosa",
        diagnostics_probe_status: "not_e2b",
        fallback_outcome: "recovered",
      }),
    );
  });
});
