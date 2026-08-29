import { createHash, randomUUID } from "node:crypto";
import type {
  Miosa as MiosaClient,
  Sandbox as MiosaSdkSandbox,
} from "@miosa/sdk";
import type { SandboxBootInfo, SandboxContext } from "@/types";

const MIOSA_SANDBOX_VERSION = "v1";
const MIOSA_ACTIVITY_TIMEOUT_SECONDS = 24 * 60 * 60;
const MIOSA_IDLE_TIMEOUT_SECONDS = 7 * 60;
const MIOSA_SNAPSHOT_EXPIRATION_DAYS = 30;

type MiosaCommandOptions = {
  cwd?: string;
  timeoutMs?: number;
  envVars?: Record<string, string>;
  envs?: Record<string, string>;
  background?: boolean;
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
  signal?: AbortSignal;
};

type MiosaCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  pid?: number;
};

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'"'"'`)}'`;

const sandboxNameForUser = (userId: string): string =>
  `hackerai-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;

const normalizeStreamLine = (line: unknown): string => {
  const value = typeof line === "string" ? line : String(line ?? "");
  return value.endsWith("\n") ? value : `${value}\n`;
};

const createMiosaClient = async (): Promise<MiosaClient> => {
  const { Miosa } = await import("@miosa/sdk");
  return new Miosa({
    apiKey: process.env.MIOSA_API_KEY,
    ...(process.env.MIOSA_BASE_URL && {
      baseUrl: process.env.MIOSA_BASE_URL,
    }),
  });
};

const bootPathFromMiosa = (
  sandbox: MiosaSdkSandbox,
): SandboxBootInfo["path"] => {
  const bootPath = sandbox.data.boot_path?.toLowerCase() ?? "";
  if (bootPath.includes("create") || bootPath.includes("provision")) {
    return "create_fresh";
  }
  return "reuse_existing";
};

/**
 * Adapts the MIOSA SDK to the command/file surface used by HackerAI tools.
 * Interactive PTY sessions are intentionally not advertised until the public
 * SDK exposes an input/resize stream in addition to terminal creation.
 */
export class MiosaSandbox {
  readonly sandboxKind = "miosa" as const;

  constructor(readonly sdkSandbox: MiosaSdkSandbox) {}

  get sandboxId(): string {
    return this.sdkSandbox.id;
  }

  readonly commands = {
    run: async (
      command: string,
      options: MiosaCommandOptions = {},
    ): Promise<MiosaCommandResult> => {
      if (options.signal?.aborted) {
        throw new DOMException("The operation was aborted", "AbortError");
      }

      const sdkOptions = {
        cwd: options.cwd ?? "/home/user",
        ...((options.envVars || options.envs) && {
          env: { ...options.envVars, ...options.envs },
        }),
        ...(options.timeoutMs && {
          timeoutSec: Math.max(1, Math.ceil(options.timeoutMs / 1000)),
        }),
      };

      if (options.background) {
        const outputPath = `/tmp/hackerai-background-${randomUUID()}.log`;
        const detachedCommand = [
          "nohup bash -lc",
          shellQuote(command),
          `>${shellQuote(outputPath)} 2>&1 < /dev/null & printf '%s' \"$!\"`,
        ].join(" ");
        const result = await this.sdkSandbox.exec.run(
          detachedCommand,
          sdkOptions,
        );
        const pid = Number.parseInt(result.stdout.trim(), 10);
        return {
          stdout: "",
          stderr: result.stderr,
          exitCode: result.exitCode,
          ...(Number.isFinite(pid) ? { pid } : {}),
        };
      }

      const stdout: string[] = [];
      const stderr: string[] = [];
      let exitCode = 0;
      const processIdPath = `/tmp/hackerai-foreground-${randomUUID()}.pid`;
      const streamedCommand = options.signal
        ? `setsid bash -lc ${shellQuote(
            `echo $$ > ${shellQuote(processIdPath)}; bash -lc ${shellQuote(command)}; status=$?; rm -f -- ${shellQuote(processIdPath)}; exit $status`,
          )}`
        : command;
      const stream = this.sdkSandbox.exec.stream(streamedCommand, sdkOptions);

      const consumeStream = async (): Promise<void> => {
        for await (const event of stream) {
          if (event.type === "exit") {
            exitCode = Number(event.exitCode ?? event.exit_code ?? 0);
            continue;
          }
          if (event.type === "stderr") {
            const chunk = normalizeStreamLine(event.line);
            stderr.push(chunk);
            options.onStderr?.(chunk);
            continue;
          }
          if (event.type === "stdout" || "line" in event) {
            const chunk = normalizeStreamLine(event.line);
            stdout.push(chunk);
            options.onStdout?.(chunk);
          }
        }
      };

      const abortError = new DOMException(
        "The operation was aborted",
        "AbortError",
      );
      let abortHandler: (() => void) | undefined;
      const abortPromise = options.signal
        ? new Promise<never>((_, reject) => {
            let abortStarted = false;
            abortHandler = () => {
              if (abortStarted) return;
              abortStarted = true;
              void this.sdkSandbox.exec
                .run(
                  `for i in $(seq 1 40); do if [ -f ${shellQuote(processIdPath)} ]; then pid=$(cat ${shellQuote(processIdPath)}); kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true; sleep 0.2; kill -KILL -- -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; rm -f -- ${shellQuote(processIdPath)}; break; fi; sleep 0.05; done`,
                  { timeoutSec: 5 },
                )
                .finally(() => {
                  void stream.return?.().catch(() => undefined);
                  reject(abortError);
                });
            };
            options.signal!.addEventListener("abort", abortHandler, {
              once: true,
            });
            if (options.signal!.aborted) abortHandler();
          })
        : null;

      try {
        if (abortPromise) {
          await Promise.race([consumeStream(), abortPromise]);
        } else {
          await consumeStream();
        }
      } finally {
        if (abortHandler) {
          options.signal?.removeEventListener("abort", abortHandler);
        }
      }

      return {
        stdout: stdout.join("").replace(/\n$/, ""),
        stderr: stderr.join("").replace(/\n$/, ""),
        exitCode,
      };
    },
    kill: async (pid: number): Promise<boolean> => {
      const result = await this.sdkSandbox.exec.run(`kill -9 ${pid}`);
      return result.exitCode === 0;
    },
  };

  readonly files = {
    write: async (
      path: string,
      content: string | Buffer | ArrayBuffer,
    ): Promise<void> => {
      const normalized =
        content instanceof ArrayBuffer ? new Uint8Array(content) : content;
      await this.sdkSandbox.files.write(path, normalized);
    },
    read: (path: string): Promise<string> =>
      this.sdkSandbox.files.readText(path),
    readText: async (path: string): Promise<string> =>
      this.sdkSandbox.files.readText(path),
    list: async (
      path: string,
    ): Promise<Array<{ name: string; path?: string }>> =>
      (await this.sdkSandbox.files.list(path)).entries,
    stat: (path: string) => this.sdkSandbox.files.stat(path),
    exists: async (path: string): Promise<boolean> => {
      try {
        await this.sdkSandbox.files.stat(path);
        return true;
      } catch {
        return false;
      }
    },
    getInfo: async (path: string) => {
      const info = await this.sdkSandbox.files.stat(path);
      return {
        type: (info.isDir ?? info.is_dir) ? "dir" : "file",
        size: info.size,
        symlinkTarget: undefined,
        modifiedTime: info.modifiedAt
          ? new Date(info.modifiedAt)
          : info.modified_at
            ? new Date(info.modified_at)
            : undefined,
      };
    },
    remove: async (path: string): Promise<void> => {
      const result = await this.sdkSandbox.exec.run(
        `rm -rf -- ${shellQuote(path)}`,
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr || `Failed to remove ${path}`);
      }
    },
  };

  async setTimeout(timeoutMs: number): Promise<void> {
    await this.sdkSandbox.extend(Math.max(1, Math.ceil(timeoutMs / 1000)));
  }

  async isRunning(): Promise<boolean> {
    await this.sdkSandbox.refresh();
    return this.sdkSandbox.state === "running";
  }

  async getHost(port: number): Promise<string> {
    return this.sdkSandbox.getHost(port);
  }

  async close(): Promise<void> {
    // Dropping the SDK object must not destroy the persistent MIOSA workspace.
  }
}

export async function ensureMiosaSandboxConnection(
  context: SandboxContext,
  options: { initialSandbox?: MiosaSandbox | null } = {},
): Promise<{ sandbox: MiosaSandbox }> {
  if (options.initialSandbox) {
    return { sandbox: options.initialSandbox };
  }

  const templateId = process.env.MIOSA_TEMPLATE_ID?.trim();
  if (!templateId) {
    throw new Error(
      "MIOSA_TEMPLATE_ID must identify the promoted HackerAI sandbox template",
    );
  }

  const startedAt = performance.now();
  const client = await createMiosaClient();
  const externalUserId = sandboxNameForUser(context.userID);
  const sdkSandbox = await client.sandboxes.getOrCreate({
    name: externalUserId,
    templateId,
    persistent: true,
    timeoutSec: MIOSA_ACTIVITY_TIMEOUT_SECONDS,
    idleTimeoutSec: MIOSA_IDLE_TIMEOUT_SECONDS,
    snapshotExpirationDays: MIOSA_SNAPSHOT_EXPIRATION_DAYS,
    keepLastSnapshots: 1,
    externalWorkspaceId: externalUserId,
    externalUserId,
    waitUntilReady: true,
    waitTimeoutSec: 60,
    metadata: {
      provider: "hackerai",
      sandboxVersion: MIOSA_SANDBOX_VERSION,
    },
  });
  const initialization = await sdkSandbox.exec.run(
    "mkdir -p /home/user/upload /home/user/agent-transcripts /home/user/terminal_full_output /home/user/agent-browser-screenshots",
    { timeoutSec: 10 },
  );
  if (initialization.exitCode !== 0) {
    throw new Error(
      initialization.stderr || "Failed to initialize MIOSA sandbox paths",
    );
  }
  const sandbox = new MiosaSandbox(sdkSandbox);
  context.setSandbox(sandbox);
  context.onBoot?.({
    path: bootPathFromMiosa(sdkSandbox),
    duration_ms: Math.round(performance.now() - startedAt),
    create_attempts: bootPathFromMiosa(sdkSandbox) === "create_fresh" ? 1 : 0,
    image_version: templateId,
  });
  return { sandbox };
}

export async function terminateMiosaSandboxesForUser(
  userId: string,
): Promise<{ total: number; killed: number; alreadyGone: number }> {
  const client = await createMiosaClient();
  const sandboxes = await client.sandboxes.list({
    externalUserId: sandboxNameForUser(userId),
  });
  let killed = 0;
  let alreadyGone = 0;
  for (const sandbox of sandboxes) {
    try {
      await sandbox.destroy();
      killed += 1;
    } catch (error) {
      const status =
        error && typeof error === "object" && "status" in error
          ? (error as { status?: unknown }).status
          : undefined;
      if (status === 404 || sandbox.state === "destroyed") {
        alreadyGone += 1;
        continue;
      }
      throw error;
    }
  }
  return { total: sandboxes.length, killed, alreadyGone };
}
