jest.mock("server-only", () => ({}), { virtual: true });

import type { UIMessage } from "ai";
import {
  prepareLocalDesktopAttachmentsForTrigger,
  rewriteSandboxFilePathsInMessages,
  stripLocalDesktopSourcePaths,
  uploadSandboxFiles,
} from "../sandbox-file-utils";

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

  it("retries url uploads in a writable directory when /tmp is not writable", async () => {
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
      stdout: "/home/alice/hackerai-upload/report.pdf",
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
            to: "/home/alice/hackerai-upload/report.pdf",
          },
        ],
      });
      expect(downloadFromUrl).toHaveBeenCalledWith(
        "https://example.com/report.pdf",
        "/tmp/hackerai-upload/report.pdf",
      );
      expect(downloadFromUrl).toHaveBeenCalledWith(
        "https://example.com/report.pdf",
        "/home/alice/hackerai-upload/report.pdf",
      );
    } finally {
      consoleWarnSpy.mockRestore();
    }
  });

  it("normalizes thrown E2B curl write errors and retries in a writable directory", async () => {
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
          stdout: "/tmp/hackerai-upload/report.pdf",
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
      const result = await uploadSandboxFiles(
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

      expect(result).toEqual({
        failedCount: 0,
        pathRewrites: [
          {
            from: "/home/user/upload/report.pdf",
            to: "/tmp/hackerai-upload/report.pdf",
          },
        ],
      });

      const homeCurlAttempts = run.mock.calls.filter(([command]) =>
        String(command).includes("-o '/home/user/upload/report.pdf'"),
      );
      const fallbackCurlAttempts = run.mock.calls.filter(([command]) =>
        String(command).includes("-o '/tmp/hackerai-upload/report.pdf'"),
      );
      expect(homeCurlAttempts).toHaveLength(3);
      expect(fallbackCurlAttempts).toHaveLength(1);
    } finally {
      consoleWarnSpy.mockRestore();
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
});
