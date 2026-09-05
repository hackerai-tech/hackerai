import { createHash, randomUUID } from "node:crypto";
import type {
  Miosa as MiosaClient,
  Sandbox as MiosaSdkSandbox,
} from "@miosa/sdk";
import type { SandboxBootInfo, SandboxContext } from "@/types";
import { createMiosaFiles } from "./miosa-files";

const MIOSA_SANDBOX_VERSION = "v2";
const MIOSA_ACTIVITY_TIMEOUT_SECONDS = 24 * 60 * 60;
const MIOSA_IDLE_TIMEOUT_SECONDS = 7 * 60;
const MIOSA_SNAPSHOT_EXPIRATION_DAYS = 30;
const MIOSA_CPU_COUNT = 4;
const MIOSA_MEMORY_MB = 4 * 1024;
const MIOSA_DISK_SIZE_MB = 20 * 1024;
const MIOSA_RUNTIME_CONTAINER_NAME = "hackerai-agent";
const DEFAULT_MIOSA_RUNTIME_IMAGE =
  "hackerai/sandbox@sha256:d00f2c023977f57fc3fa6effc6ea41de28d445170bfa2314564e5eab2ef03976";

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

export const miosaCancellationCommand = (processIdPath: string): string =>
  [
    "for i in $(seq 1 40); do",
    `if [ -f ${shellQuote(processIdPath)} ]; then`,
    `pid=$(cat ${shellQuote(processIdPath)})`,
    'case "$pid" in ""|*[!0-9]*|0|1) exit 1;; esac',
    'kill -TERM -- -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    "sleep 0.2",
    'if ! kill -KILL -- -"$pid" 2>/dev/null && ! kill -KILL "$pid" 2>/dev/null; then if kill -0 -- -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then exit 1; fi; fi',
    `rm -f -- ${shellQuote(processIdPath)}`,
    "exit 0",
    "fi",
    "sleep 0.05",
    "done",
    // A missing PID is not evidence that the process group was terminated.
    "exit 1",
  ].join("\n");

const externalUserIdForUser = (userId: string): string =>
  `hackerai-${createHash("sha256").update(userId).digest("hex").slice(0, 24)}`;

const sandboxNameForUser = (userId: string): string =>
  `${externalUserIdForUser(userId)}-${MIOSA_SANDBOX_VERSION}`;

const dockerExecCommand = (
  command: string,
  options: Pick<MiosaCommandOptions, "cwd" | "envVars" | "envs"> = {},
): string => {
  const env = { ...options.envVars, ...options.envs };
  const envArgs = Object.entries(env).flatMap(([key, value]) => [
    "--env",
    shellQuote(`${key}=${value}`),
  ]);
  return [
    "docker exec",
    "--workdir",
    shellQuote(options.cwd ?? "/home/user"),
    ...envArgs,
    shellQuote(MIOSA_RUNTIME_CONTAINER_NAME),
    "bash -lc",
    shellQuote(command),
  ].join(" ");
};

const runtimeInitializationCommand = (runtimeImage: string): string => {
  const image = shellQuote(runtimeImage);
  const container = shellQuote(MIOSA_RUNTIME_CONTAINER_NAME);
  return [
    "set -eu",
    "mkdir -p /home/user/upload /home/user/agent-transcripts /home/user/terminal_full_output /home/user/agent-browser-screenshots",
    `docker image inspect ${image} >/dev/null 2>&1 || docker pull ${image}`,
    `expected_image_id=$(docker image inspect --format '{{.Id}}' ${image})`,
    `container_image_id=$(docker inspect --format '{{.Image}}' ${container} 2>/dev/null || true)`,
    `if [ -n "$container_image_id" ] && [ "$container_image_id" != "$expected_image_id" ]; then docker rm -f ${container}; container_image_id=; fi`,
    `if [ -z "$container_image_id" ]; then docker run -d --name ${container} --restart unless-stopped --network host --cap-add=NET_RAW --cap-add=NET_ADMIN --cap-add=SYS_PTRACE --env HOME=/home/user --workdir /home/user --volume /home/user:/home/user ${image} sleep infinity; elif [ "$(docker inspect --format '{{.State.Running}}' ${container})" != "true" ]; then docker start ${container}; fi`,
    `docker exec --workdir /home/user ${container} bash -lc 'test -x /usr/bin/nmap && test -x /usr/bin/nuclei && test -x /usr/bin/ffuf'`,
  ].join("; ");
};

const initializeMiosaRuntime = async (
  sdkSandbox: MiosaSdkSandbox,
  runtimeImage: string,
): Promise<void> => {
  const stream = sdkSandbox.exec.stream(
    runtimeInitializationCommand(runtimeImage),
    { timeoutSec: 15 * 60 },
  );
  const stderr: string[] = [];
  let exitCode: number | null = null;
  for await (const event of stream) {
    if (event.type === "stderr") stderr.push(event.data);
    if (event.type === "exit") {
      exitCode = Number(event.exitCode ?? event.exit_code ?? 0);
    }
  }
  if (exitCode === null) {
    throw new Error("MIOSA runtime initialization ended without an exit event");
  }
  if (exitCode !== 0) {
    throw new Error(
      stderr.join("").trim() || "Failed to initialize MIOSA sandbox runtime",
    );
  }
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
 */
export class MiosaSandbox {
  readonly sandboxKind = "miosa" as const;

  readonly files: ReturnType<typeof createMiosaFiles>;

  constructor(readonly sdkSandbox: MiosaSdkSandbox) {
    this.files = createMiosaFiles(sdkSandbox);
  }

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
        ...(options.signal && { signal: options.signal }),
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
          dockerExecCommand(detachedCommand, options),
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
      let exitCode: number | null = null;
      const processIdPath = `/tmp/hackerai-foreground-${randomUUID()}.pid`;
      // setsid may fork when Docker makes it a process-group leader. Wait for
      // that child so exec does not report success before its final output or
      // lose the command's actual exit status.
      const streamedCommand = options.signal
        ? `setsid --wait bash -lc ${shellQuote(
            `echo $$ > ${shellQuote(processIdPath)}; bash -lc ${shellQuote(command)}; status=$?; rm -f -- ${shellQuote(processIdPath)}; exit $status`,
          )}`
        : command;
      const stream = this.sdkSandbox.exec.stream(
        dockerExecCommand(streamedCommand, options),
        sdkOptions,
      );

      const consumeStream = async (): Promise<void> => {
        for await (const event of stream) {
          if (event.type === "exit") {
            exitCode = Number(event.exitCode ?? event.exit_code ?? 0);
            continue;
          }
          if (event.type === "stderr") {
            const chunk = event.data ?? event.line;
            if (typeof chunk !== "string") continue;
            stderr.push(chunk);
            options.onStderr?.(chunk);
            continue;
          }
          if (event.type === "stdout" || "line" in event) {
            const chunk = event.data ?? event.line;
            if (typeof chunk !== "string") continue;
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
      let cancellation: Promise<unknown> | undefined;
      const abortPromise = options.signal
        ? new Promise<never>((_, reject) => {
            let abortStarted = false;
            abortHandler = () => {
              if (abortStarted) return;
              abortStarted = true;
              cancellation = this.sdkSandbox.exec
                .run(
                  dockerExecCommand(miosaCancellationCommand(processIdPath)),
                  { timeoutSec: 5 },
                )
                .then(
                  (result) => {
                    if (result.exitCode !== 0) {
                      const error = new Error(
                        "MIOSA command cancellation could not be confirmed",
                      );
                      reject(error);
                      throw error;
                    }
                    void stream.return?.().catch(() => undefined);
                    reject(abortError);
                  },
                  (error) => {
                    reject(error);
                    throw error;
                  },
                );
              void cancellation.catch(() => undefined);
            };
            options.signal!.addEventListener("abort", abortHandler, {
              once: true,
            });
            if (options.signal!.aborted) abortHandler();
          })
        : null;

      let streamFailed = false;
      let streamError: unknown;
      try {
        if (abortPromise) {
          await Promise.race([consumeStream(), abortPromise]);
        } else {
          await consumeStream();
        }
      } catch (error) {
        streamFailed = true;
        streamError = error;
      } finally {
        if (abortHandler) {
          options.signal?.removeEventListener("abort", abortHandler);
        }
      }
      // Native stream abort may settle before the remote process-group kill.
      // Await that cleanup even after rejection; never claim a confirmed abort
      // if cleanup failed, or mask an unrelated stream failure after cleanup.
      if (options.signal?.aborted) {
        await cancellation;
        if (
          streamFailed &&
          !(streamError instanceof Error && streamError.name === "AbortError")
        ) {
          throw streamError;
        }
        throw abortError;
      }
      if (streamFailed) throw streamError;

      if (exitCode === null) {
        throw new Error("MIOSA command stream ended without an exit event");
      }

      return {
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        exitCode,
      };
    },
    kill: async (pid: number): Promise<boolean> => {
      const result = await this.sdkSandbox.exec.run(
        dockerExecCommand(`kill -9 ${pid}`),
      );
      return result.exitCode === 0;
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
  const externalUserId = externalUserIdForUser(context.userID);
  const sdkSandbox = await client.sandboxes.getOrCreate({
    name: sandboxNameForUser(context.userID),
    templateId,
    cpuCount: MIOSA_CPU_COUNT,
    memoryMb: MIOSA_MEMORY_MB,
    diskSizeMb: MIOSA_DISK_SIZE_MB,
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
  if (sdkSandbox.state !== "running") {
    throw new Error(
      `MIOSA readiness returned non-running state: ${sdkSandbox.state}`,
    );
  }
  const runtimeImage =
    process.env.MIOSA_RUNTIME_IMAGE?.trim() || DEFAULT_MIOSA_RUNTIME_IMAGE;
  await initializeMiosaRuntime(sdkSandbox, runtimeImage);
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
    externalUserId: externalUserIdForUser(userId),
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
