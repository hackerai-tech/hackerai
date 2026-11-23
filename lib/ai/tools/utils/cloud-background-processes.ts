import { randomBytes } from "node:crypto";
import type { Sandbox } from "@e2b/code-interpreter";
import type { UIMessage } from "ai";
import type { SandboxManager } from "@/types";
import { buildSandboxCommandOptions } from "./sandbox-command-options";
import { isE2BSandbox } from "./sandbox-types";

/**
 * Cloud (E2B) background processes.
 *
 * E2B kills a command when its `timeoutMs` deadline passes, including commands
 * started with `background: true`, so long-lived services cannot run under the
 * per-command deadline. Instead, a short launcher detaches the process with
 * `setsid nohup` (its own session, immune to the launcher's deadline and to
 * run-end PTY cleanup) and records it under one sandbox directory. The process
 * then lives as long as the sandbox: it freezes while the sandbox is paused and
 * continues on resume.
 *
 * The sandbox directory is the registry: the cap, the cap-reached listing and
 * the turn-start inventory all read it inside the sandbox, so every chat and
 * subagent sharing the user's sandbox sees the same processes.
 */
export const CLOUD_BACKGROUND_DIRECTORY = "/tmp/hackerai-background";
/** Sandboxes have 4 vCPU / 4 GiB shared by every chat; keep services few. */
export const MAX_CLOUD_BACKGROUND_PROCESSES = 5;
/** The launcher returns as soon as the detached process records its PID. */
const LAUNCH_TIMEOUT_MS = 30_000;
const INVENTORY_TIMEOUT_MS = 10_000;
const LABEL_MAX_CHARS = 80;
const RETENTION_DAYS = 7;
const MARKER = "HACKERAI_BG";
const ID_PATTERN = /^bg-[a-f0-9]{8}$/;

export type CloudBackgroundProcess = {
  id: string;
  pid: number;
  /** Epoch milliseconds from the sandbox clock. */
  startedAt: number;
  label: string;
  logPath: string;
};

export type CloudBackgroundStartResult =
  | { kind: "started"; process: CloudBackgroundProcess }
  | { kind: "cap_reached"; running: CloudBackgroundProcess[] };

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** A single-line command label that cannot close a prompt tag. */
export function cloudBackgroundLabel(command: string): string {
  const label = command
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .trim();
  return label.length > LABEL_MAX_CHARS
    ? `${label.slice(0, LABEL_MAX_CHARS - 1)}…`
    : label;
}

export const newCloudBackgroundId = () =>
  `bg-${randomBytes(4).toString("hex")}`;

export const cloudBackgroundLogPath = (id: string) =>
  `${CLOUD_BACKGROUND_DIRECTORY}/${id}.log`;

/**
 * Shared shell prelude: lock the registry, then define `alive` and `list`.
 * A PID only counts while its command line still names this registry entry,
 * so a recycled PID never keeps a finished entry alive. Finished entries are
 * removed after the retention period; their logs stay readable until then.
 */
function registryPrelude(): string {
  return [
    `d=${shellQuote(CLOUD_BACKGROUND_DIRECTORY)}`,
    `mkdir -p "$d" && chmod 700 "$d" || exit 70`,
    `exec 9>"$d/.lock"; flock -w 10 9 || exit 71`,
    `alive() { p=$(cat "$d/$1.pid" 2>/dev/null) && [ -n "$p" ] && kill -0 "$p" 2>/dev/null && grep -qaF -- "$d/$1.sh" "/proc/$p/cmdline" 2>/dev/null; }`,
    `list() { for f in "$d"/bg-*.pid; do [ -e "$f" ] || continue; i=$(basename "$f" .pid); if alive "$i"; then printf '${MARKER} running\\t%s\\t%s\\t%s\\t%s\\n' "$i" "$(cat "$d/$i.pid")" "$(cat "$d/$i.started" 2>/dev/null)" "$(head -c 400 "$d/$i.label" 2>/dev/null | tr -d '\\n\\t')"; elif [ -n "$(find "$f" -mtime +${RETENTION_DAYS} 2>/dev/null)" ]; then rm -f "$d/$i".*; fi; done; }`,
  ].join("\n");
}

/** Build the launcher. Exported for tests that execute it in a real shell. */
export function buildCloudBackgroundLaunchScript(args: {
  id: string;
  command: string;
  label: string;
  max?: number;
}): string {
  if (!ID_PATTERN.test(args.id))
    throw new Error("Invalid background process ID");
  const max = args.max ?? MAX_CLOUD_BACKGROUND_PROCESSES;
  return [
    registryPrelude(),
    `id=${shellQuote(args.id)}`,
    // Report the PID once the detached wrapper has written it.
    `report() { n=0; while [ ! -s "$d/$id.pid" ] && [ $n -lt 100 ]; do sleep 0.1; n=$((n+1)); done; [ -s "$d/$id.pid" ] || exit 72; echo "${MARKER} started $(cat "$d/$id.pid") $(cat "$d/$id.started")"; exit 0; }`,
    // A retried launch reports the original process instead of a duplicate.
    `[ -e "$d/$id.sh" ] && report`,
    `running=$(list); count=$(printf '%s' "$running" | grep -c '^${MARKER} running')`,
    `if [ "$count" -ge ${max} ]; then echo "${MARKER} cap $count"; printf '%s\\n' "$running"; exit 0; fi`,
    `printf '%s\\n' ${shellQuote(args.command)} > "$d/$id.sh"`,
    `printf '%s\\n' ${shellQuote(args.label)} > "$d/$id.label"`,
    `echo $(($(date +%s%N)/1000000)) > "$d/$id.started"`,
    // The wrapper is the new session leader, so `kill -- -PID` stops the
    // whole process group. It records its own PID and the command's exit code.
    `setsid nohup bash -c 'echo $$ > "$3"; bash "$1"; echo $? > "$2"' hackerai-background "$d/$id.sh" "$d/$id.exit" "$d/$id.pid" > "$d/$id.log" 2>&1 < /dev/null 9>&- &`,
    `report`,
  ].join("\n");
}

export function buildCloudBackgroundInventoryScript(): string {
  return [
    `[ -d ${shellQuote(CLOUD_BACKGROUND_DIRECTORY)} ] || exit 0`,
    registryPrelude(),
    "list",
  ].join("\n");
}

/** Parse registry rows; sandbox content is untrusted, so validate each field. */
export function parseCloudBackgroundRows(
  stdout: string,
): CloudBackgroundProcess[] {
  const processes: CloudBackgroundProcess[] = [];
  for (const line of stdout.split("\n")) {
    const [marker, id, pid, startedAt, label = ""] = line.split("\t");
    if (marker !== `${MARKER} running` || !ID_PATTERN.test(id ?? "")) continue;
    const parsedPid = Number(pid);
    if (!Number.isSafeInteger(parsedPid) || parsedPid <= 0) continue;
    const parsedStartedAt = Number(startedAt);
    processes.push({
      id,
      pid: parsedPid,
      startedAt: Number.isSafeInteger(parsedStartedAt) ? parsedStartedAt : 0,
      label: cloudBackgroundLabel(label),
      logPath: cloudBackgroundLogPath(id),
    });
    if (processes.length >= MAX_CLOUD_BACKGROUND_PROCESSES * 2) break;
  }
  return processes.sort((a, b) => a.startedAt - b.startedAt);
}

/** E2B raises CommandExitError for a nonzero exit; keep its output. */
async function runScript(
  sandbox: Sandbox,
  script: string,
  options: {
    timeoutMs: number;
    envs?: Record<string, string>;
    signal?: AbortSignal;
  },
): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await sandbox.commands.run(script, {
      ...buildSandboxCommandOptions(sandbox, undefined, options.envs),
      timeoutMs: options.timeoutMs,
      ...(options.signal ? { signal: options.signal } : {}),
    } as Parameters<Sandbox["commands"]["run"]>[1]);
    return { stdout: result.stdout ?? "", exitCode: result.exitCode ?? 0 };
  } catch (error) {
    const exitCode = (error as { exitCode?: unknown })?.exitCode;
    if (typeof exitCode === "number") {
      return {
        stdout: String((error as { stdout?: unknown }).stdout ?? ""),
        exitCode,
      };
    }
    throw error;
  }
}

/**
 * Start `command` detached in the cloud sandbox. `id` makes the launch
 * idempotent: retrying the same ID reports the original process.
 */
export async function startCloudBackgroundProcess(
  sandbox: Sandbox,
  args: {
    command: string;
    label: string;
    envs?: Record<string, string>;
    signal?: AbortSignal;
    id?: string;
  },
): Promise<CloudBackgroundStartResult> {
  const id = args.id ?? newCloudBackgroundId();
  const { stdout, exitCode } = await runScript(
    sandbox,
    buildCloudBackgroundLaunchScript({
      id,
      command: args.command,
      label: cloudBackgroundLabel(args.label),
    }),
    { timeoutMs: LAUNCH_TIMEOUT_MS, envs: args.envs, signal: args.signal },
  );
  if (stdout.includes(`${MARKER} cap `)) {
    return { kind: "cap_reached", running: parseCloudBackgroundRows(stdout) };
  }
  const started = new RegExp(`${MARKER} started (\\d+) (\\d+)`).exec(stdout);
  if (exitCode !== 0 || !started) {
    throw new Error(
      `Background process launcher failed with exit code ${exitCode}`,
    );
  }
  return {
    kind: "started",
    process: {
      id,
      pid: Number(started[1]),
      startedAt: Number(started[2]),
      label: cloudBackgroundLabel(args.label),
      logPath: cloudBackgroundLogPath(id),
    },
  };
}

export async function listCloudBackgroundProcesses(
  sandbox: Sandbox,
): Promise<CloudBackgroundProcess[]> {
  const { stdout, exitCode } = await runScript(
    sandbox,
    buildCloudBackgroundInventoryScript(),
    { timeoutMs: INVENTORY_TIMEOUT_MS },
  );
  if (exitCode !== 0) {
    throw new Error(`Background inventory failed with exit code ${exitCode}`);
  }
  return parseCloudBackgroundRows(stdout);
}

const formatStartedAt = (startedAt: number) =>
  startedAt > 0 ? new Date(startedAt).toISOString() : "unknown";

export function describeCloudBackgroundProcess(
  process: CloudBackgroundProcess,
): string {
  return `- ${process.id} (PID ${process.pid}, started ${formatStartedAt(process.startedAt)}): ${process.label} — log ${process.logPath}`;
}

export function formatCloudBackgroundStarted(
  process: CloudBackgroundProcess,
): string {
  return [
    `Started background process ${process.id} with PID ${process.pid}. It keeps running after this turn for as long as the cloud sandbox exists (it pauses and resumes with the sandbox).`,
    `Output (stdout and stderr) goes to ${process.logPath}; read it with ordinary commands such as \`tail -n 50 ${process.logPath}\`.`,
    `Check it with \`kill -0 ${process.pid}\`; stop it with \`kill -- -${process.pid}\`. After it exits, its exit code is in ${CLOUD_BACKGROUND_DIRECTORY}/${process.id}.exit.`,
    "This PID is not a terminal session; do not pass it to interact_terminal_session.",
  ].join("\n");
}

export function formatCloudBackgroundCapReached(
  running: CloudBackgroundProcess[],
): string {
  return [
    `Background process limit reached: at most ${MAX_CLOUD_BACKGROUND_PROCESSES} background processes can run at once in the cloud sandbox. Nothing was started.`,
    "Reuse a running process, or stop one you no longer need with `kill -- -<PID>` and try again:",
    ...running.map(describeCloudBackgroundProcess),
  ].join("\n");
}

/** Bounded prompt text; null when nothing is running. */
export function formatCloudBackgroundInventory(
  processes: CloudBackgroundProcess[],
): string | null {
  if (processes.length === 0) return null;
  const shown = processes.slice(0, MAX_CLOUD_BACKGROUND_PROCESSES);
  return [
    "<cloud_background_processes>",
    "These background processes started earlier are still running in the cloud sandbox. Reuse them instead of starting duplicates; read output from each log file, and stop one with `kill -- -<PID>` when it is no longer needed.",
    ...shown.map(describeCloudBackgroundProcess),
    ...(processes.length > shown.length
      ? [`- …and ${processes.length - shown.length} more`]
      : []),
    "</cloud_background_processes>",
  ].join("\n");
}

/** Whether this chat ever started a cloud background process. */
export function chatHasCloudBackgroundStart(messages: UIMessage[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.parts?.some((part) => {
        if (part.type !== "tool-run_terminal_cmd") return false;
        const output = (part as { output?: unknown }).output as
          { result?: { backgroundId?: unknown } } | undefined;
        return typeof output?.result?.backgroundId === "string";
      }),
  );
}

export type CloudBackgroundInventoryOutcome =
  "listed" | "timeout" | "failed" | "not_cloud";

/**
 * Turn-start inventory for Agent runs. It runs only when the chat previously
 * started a cloud background process, so ordinary turns never acquire or
 * resume a sandbox for it, and it never delays the turn past `timeoutMs`.
 * A slower acquisition keeps going and is reused by the turn's first tool.
 */
export async function getCloudBackgroundInventoryReminder(args: {
  sandboxManager: Pick<
    SandboxManager,
    "getSandbox" | "getEffectivePreference" | "isSandboxUnavailable"
  >;
  messages: UIMessage[];
  timeoutMs: number;
  onOutcome?: (outcome: CloudBackgroundInventoryOutcome, count: number) => void;
}): Promise<string | null> {
  if (
    args.sandboxManager.getEffectivePreference() !== "e2b" ||
    args.sandboxManager.isSandboxUnavailable() ||
    !chatHasCloudBackgroundStart(args.messages)
  ) {
    return null;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), args.timeoutMs);
  });
  const listed = (async () => {
    const { sandbox } = await args.sandboxManager.getSandbox();
    if (!isE2BSandbox(sandbox)) return "not_cloud" as const;
    return listCloudBackgroundProcesses(sandbox);
  })();
  try {
    const result = await Promise.race([listed, timedOut]);
    if (result === "timeout" || result === "not_cloud") {
      args.onOutcome?.(result, 0);
      // The losing branch may still reject; it must not become unhandled.
      listed.catch(() => {});
      return null;
    }
    args.onOutcome?.("listed", result.length);
    return formatCloudBackgroundInventory(result);
  } catch {
    args.onOutcome?.("failed", 0);
    return null;
  } finally {
    clearTimeout(timer);
  }
}
