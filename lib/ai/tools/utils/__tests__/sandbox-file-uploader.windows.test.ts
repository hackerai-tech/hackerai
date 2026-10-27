jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/convex/s3Utils", () => ({ generateS3UploadUrl: jest.fn() }));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  buildShellSpawn,
  findGitBash,
  windowsSystemExecutable,
} from "@/packages/local/src/utils";
import { CentrifugoSandbox } from "../centrifugo-sandbox";
import { uploadSandboxFileToConvex } from "../sandbox-file-uploader";

// The dedicated Windows CI job executes the real command interpreter; a mocked
// stdout cannot catch SETLOCAL being ineffective outside a batch file.
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;

windowsDescribe("Windows generated-file metadata command", () => {
  let directory: string;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  const uploadUrl = jest.mocked(generateS3UploadUrl);
  const convexClient = jest.mocked(getConvexClient);

  function runCommand(
    command: string,
    envVars: Record<string, string> = {},
    delayedExpansion = false,
  ) {
    // Match the cmd.exe relay contract: env assignments precede the command in
    // the same /C invocation. Use the production shell argument/quoting helper.
    const assignments = Object.entries(envVars)
      .map(
        ([key, value]) =>
          `set "${key}=${value.replace(/%/g, "%%").replace(/"/g, '""')}"`,
      )
      .join(" && ");
    const fullCommand = assignments ? `${assignments} && ${command}` : command;
    const spec = buildShellSpawn("cmd.exe", "/C", fullCommand);
    const result = spawnSync(
      "cmd.exe",
      ["/d", delayedExpansion ? "/v:on" : "/v:off", ...spec.args],
      {
        ...spec.options,
        encoding: "utf8",
        timeout: 5_000,
        cwd: directory,
      },
    );
    if (result.error) throw result.error;
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      exitCode: result.status ?? -1,
    };
  }

  function sandbox(delayedExpansion = false) {
    return {
      sandboxKind: "centrifugo" as const,
      isWindows: () => true,
      detectShell: async () => "cmd",
      supportsNativeFileRelay: () => false,
      commands: {
        run: jest.fn(
          async (
            command: string,
            options?: { envVars?: Record<string, string> },
          ) => runCommand(command, options?.envVars, delayedExpansion),
        ),
      },
      files: { uploadToUrl: jest.fn(async () => undefined) },
    };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "hackerai-metadata-"));
    warn = jest.spyOn(console, "warn").mockImplementation(() => undefined);
    error = jest.spyOn(console, "error").mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://fixture.convex.cloud";
    process.env.CONVEX_SERVICE_ROLE_KEY = "owned-fixture-service-key";
    uploadUrl.mockResolvedValue({
      uploadUrl: "https://fixture.invalid/upload",
      s3Key: "owned-fixture",
      storageLocation: { region: "us-west-2", bucket: "owned-fixture" },
    });
    convexClient.mockReturnValue({
      action: jest.fn(async () => ({
        url: "https://fixture.invalid/download",
        fileId: "fixture",
        tokens: 0,
      })),
    } as any);
  });

  afterEach(() => {
    warn.mockRestore();
    error.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  });

  test.each(["cmd", "git-bash"])(
    "persists large UTF-8 output through real %s commands",
    async (kind) => {
      const shell =
        kind === "cmd" ? windowsSystemExecutable("cmd.exe") : findGitBash();
      expect(shell).not.toBeNull();
      const adapter = new CentrifugoSandbox(
        "fixture-user",
        {
          connectionId: "fixture-connection",
          name: "fixture",
          osInfo: {
            platform: "win32",
            arch: "x64",
            release: "test",
            hostname: "fixture",
          },
          capabilities: { commands: true },
        },
        { wsUrl: "ws://fixture.invalid", tokenSecret: "fixture-secret" },
      );
      jest
        .spyOn(adapter.commands, "run")
        .mockImplementation(async (command) => {
          const spec = buildShellSpawn(
            shell!,
            kind === "cmd" ? "/C" : "-c",
            command,
          );
          const result = spawnSync(shell!, spec.args, {
            ...spec.options,
            encoding: "utf8",
            timeout: 10_000,
            cwd: directory,
          });
          if (result.error) throw result.error;
          return {
            stdout: result.stdout ?? "",
            stderr: result.stderr ?? "",
            exitCode: result.status ?? -1,
          };
        });
      const output = "owned UTF-8 \u03bb \u2713\n".repeat(4000);
      const destination = join(directory, "Research & Dev", "output.txt");
      await adapter.files.write(destination, output);
      expect(readFileSync(destination, "utf8")).toBe(output);
      expect(adapter.commands.run).toHaveBeenCalledWith(
        "echo $BASH_VERSION",
        expect.anything(),
      );
    },
  );

  test("reproduces the old inline SETLOCAL failure with an existing file", () => {
    const path = join(directory, "existing.txt");
    writeFileSync(path, "fixture");
    const result = runCommand(
      'setlocal EnableDelayedExpansion && for %I in ("!HACKERAI_FILE_SIZE_PATH!") do @echo %~zI',
      { HACKERAI_FILE_SIZE_PATH: path },
    );
    expect(result.exitCode).toBe(0);
    expect(Number.parseInt(result.stdout.trim(), 10)).toBeNaN();
  });

  test.each([false, true])(
    "uploads owned file metadata when the parent delayed expansion is %s",
    async (parentDelayedExpansion) => {
      const adapter = sandbox(parentDelayedExpansion);
      // Valid Windows file names containing shell metacharacters must remain data.
      for (const [name, size] of [
        ["empty.txt", 0],
        ["Research & Dev (owned).txt", 257],
        ["report & mkdir INJECTED & rem owned.txt", 17],
      ] as const) {
        const path = join(directory, name);
        writeFileSync(path, Buffer.alloc(size, 65));
        await uploadSandboxFileToConvex({
          sandbox: adapter as any,
          fullPath: path,
          mediaType: "text/plain",
          userId: "owned-fixture-user",
        });
        expect(uploadUrl).toHaveBeenLastCalledWith(
          name,
          "text/plain",
          "owned-fixture-user",
          size,
        );
      }
      expect(adapter.files.uploadToUrl).toHaveBeenCalledTimes(3);
      expect(existsSync(join(directory, "INJECTED"))).toBe(false);
    },
  );

  test("does not publish an absent file", async () => {
    const adapter = sandbox();
    await expect(
      uploadSandboxFileToConvex({
        sandbox: adapter as any,
        fullPath: join(directory, "absent.txt"),
        userId: "owned-fixture-user",
      }),
    ).rejects.toThrow(/Failed to get file size/);
    expect(uploadUrl).not.toHaveBeenCalled();
    expect(adapter.files.uploadToUrl).not.toHaveBeenCalled();
  });

  test("does not run a project-local cmd.bat during file metadata lookup", async () => {
    const marker = join(directory, "shadowed.txt");
    writeFileSync(
      join(directory, "cmd.bat"),
      "@echo off\r\necho shadowed>shadowed.txt\r\nexit /b 0\r\n",
    );
    const path = join(directory, "ordinary.txt");
    writeFileSync(path, Buffer.alloc(17, 65));

    const adapter = sandbox();
    await uploadSandboxFileToConvex({
      sandbox: adapter as any,
      fullPath: path,
      mediaType: "text/plain",
      userId: "owned-fixture-user",
    });

    expect(uploadUrl).toHaveBeenLastCalledWith(
      "ordinary.txt",
      "text/plain",
      "owned-fixture-user",
      17,
    );
    expect(existsSync(marker)).toBe(false);
  });

  test("rejects a command-breaking path before any shell command", async () => {
    const adapter = sandbox();
    await expect(
      uploadSandboxFileToConvex({
        sandbox: adapter as any,
        fullPath: join(directory, 'owned" & echo INJECTED>sentinel.txt & "'),
        userId: "owned-fixture-user",
      }),
    ).rejects.toThrow(/unsupported character/);
    expect(adapter.commands.run).not.toHaveBeenCalled();
    expect(uploadUrl).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "sentinel.txt"))).toBe(false);
  });
});
