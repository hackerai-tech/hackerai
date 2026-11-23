import "server-only";
import { createHash, randomBytes } from "node:crypto";

import {
  CommandExitError,
  Sandbox,
  TimeoutError,
  type CommandHandle,
  type CommandResult,
} from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import { browserSessionCommand } from "@/lib/ai/tools/utils/browser-session-program";
import { buildSandboxCommandOptions } from "@/lib/ai/tools/utils/sandbox-command-options";
import { checkpointCloudErrorContext } from "@/lib/ai/tools/utils/persistence-failure";
import {
  BROWSER_BRIDGE_CLOSED_EXIT,
  browserBridgeCommand,
  browserBridgeFailureContext,
  type BrowserBridgeFailureContext,
} from "./bridge-program";
import {
  browserDaemonCommand,
  BROWSER_DAEMON_PRECONDITION_REASONS,
  BROWSER_WRAPPER_ACTIONS,
  BROWSER_WRAPPER_AGES,
  BROWSER_OPEN_IDLE_ENV_VALUES,
  BROWSER_DAEMON_DEADLINE_PHASES,
  BROWSER_DAEMON_RESPONSE_VALIDATIONS,
  BROWSER_DAEMON_SCREENSHOT_REFUSALS,
  BROWSER_CLI_AT_PREPARE_STATUSES,
  BROWSER_WRAPPER_PROCESS_VISIBILITIES,
  BROWSER_OPEN_SOCKET_RETURN_STATUSES,
  BROWSER_OPEN_INFO_FLAGS,
  BROWSER_OPEN_SOCKET_DIRECTORY_DECLARATIONS,
  BROWSER_WRAPPER_COMMAND_CLASSES,
  BROWSER_WRAPPER_RESULTS,
  BROWSER_WRAPPER_RESULT_ELAPSED,
  BROWSER_DAEMON_VERSION_FILE_STATUSES,
  BROWSER_CLOSE_PROOF_FAILURES,
  BROWSER_DAEMON_WAIT_DEFERRED,
  BROWSER_DAEMON_OPEN_DEFERRED,
  BROWSER_DAEMON_SESSION_CLOSED,
  BROWSER_DAEMON_PROGRESS_FRAMES,
  BROWSER_DAEMON_PROGRESS_SEQUENCES,
} from "./daemon-program";
import {
  browserRelayProgram,
  RELAY_START_PROGRAM,
  RELAY_RENEW_FAILURE_CODES,
  RELAY_RENEW_PROGRAM,
  RELAY_STOP_ALIVE_BRANCHES,
  RELAY_STOP_PROGRAM,
  RELAY_STOP_RECEIPT_CODES,
  RELAY_STOP_RECEIPT_STAGES,
} from "./relay-program";

export type BrowserSessionLocation = {
  userId: string;
  sandboxId: string;
  triggerRegion: string | null;
  directory: string;
  expiresAt: number;
};

export class BrowserPreviewUnavailable extends Error {
  constructor(readonly state: "loading" | "disconnected" | "closed") {
    super(`Browser preview ${state}`);
  }
}

/**
 * An opted-in fresh capture yielded to the selected session's verified active
 * WAIT, or its status lookup reached the original deadline behind a verified
 * still-running plain OPEN (reason "open"). Carries no frame, freshness or
 * failure context; only the opted-in passive GET may present it, and nothing
 * else should treat it as a capture.
 */
export class BrowserPreviewRefreshDeferred extends Error {
  constructor(readonly reason: "wait" | "open" = "wait") {
    super("Browser preview refresh deferred");
  }
}

// Keep only the existing bounded SDK projection, never the original error or
// private file path. Other callers retain the same loading response.
const sessionReadFailures = new WeakMap<
  object,
  ReturnType<typeof checkpointCloudErrorContext>
>();

const returnedRelayRenewExits = new WeakMap<
  BrowserPreviewUnavailable,
  number
>();

/** Read closed SDK classes and own numeric exit data, never command output. */
export function browserRelayRenewFailureContext(error: unknown) {
  let kind:
    "command_exit" | "timeout" | "other_error" | "thrown_value" | "unreadable" =
    "thrown_value";
  let exitCode: number | "none" | "other" = "none";
  try {
    const returnedExit =
      error instanceof BrowserPreviewUnavailable
        ? returnedRelayRenewExits.get(error)
        : undefined;
    const isSdkExit = error instanceof CommandExitError;
    if (isSdkExit || returnedExit !== undefined) {
      kind = "command_exit";
      exitCode = "other";
      const result = isSdkExit
        ? Object.getOwnPropertyDescriptor(error, "result")?.value
        : undefined;
      const value =
        returnedExit ??
        (result && typeof result === "object"
          ? Object.getOwnPropertyDescriptor(result, "exitCode")?.value
          : undefined);
      if (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 0 &&
        value <= 255
      )
        exitCode = value;
    } else if (error instanceof TimeoutError) {
      kind = "timeout";
    } else if (error instanceof Error) {
      kind = "other_error";
    }
  } catch {
    kind = "unreadable";
    exitCode = "other";
  }
  const reason = Object.entries(RELAY_RENEW_FAILURE_CODES).find(
    ([, code]) => code === exitCode,
  )?.[0];
  return {
    relay_renew_diagnostic_version: 2,
    relay_renew_error_kind: kind,
    relay_renew_command_exit_code: exitCode,
    ...(reason === undefined ? {} : { relay_renew_failure_reason: reason }),
  };
}

const returnedRelayStopExits = new WeakMap<object, number | "other">();
/** The daemon helper's closed exit3 deadline tuple; any other shape is unmeasured. */
const daemonDeadlinePhase = (parsed: unknown) => {
  const deadline = (parsed as { deadline?: unknown } | null | undefined)
    ?.deadline;
  return Array.isArray(deadline) &&
    deadline.length === 2 &&
    deadline[0] === 1 &&
    BROWSER_DAEMON_DEADLINE_PHASES.includes(deadline[1])
    ? (deadline[1] as (typeof BROWSER_DAEMON_DEADLINE_PHASES)[number])
    : undefined;
};

const exitStatus = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 255
    ? value
    : "other";

type RelayStopReceiptContext = {
  // 2 only for a recorded version 2 receipt; every other status keeps 1.
  relay_stop_receipt_version: 1 | 2;
  // Absent: no output (including an older program); invalid: anything but
  // the exact bounded receipt for this exit; unreadable: non-data properties.
  relay_stop_receipt_status: "recorded" | "absent" | "invalid" | "unreadable";
  // The first failure across the invocation's relays, not each relay's result.
  relay_stop_first_failure?: "drain_deadline" | "filesystem";
  relay_stop_first_filesystem_stage?: (typeof RELAY_STOP_RECEIPT_STAGES)[number];
  relay_stop_first_filesystem_code?: (typeof RELAY_STOP_RECEIPT_CODES)[number];
  // Aggregate counts, capped at 16 (meaning 16 or more).
  relay_stop_drain_deadline_count?: number;
  relay_stop_filesystem_failure_count?: number;
  // Version 2 with a deadline: the check that last kept the first relay to
  // reach its deadline alive, independent of the first overall failure.
  relay_stop_first_deadline_alive_branch?: (typeof RELAY_STOP_ALIVE_BRANCHES)[number];
  relay_stop_first_deadline_alive_code?: (typeof RELAY_STOP_RECEIPT_CODES)[number];
};

export type BrowserRelayStopFailureContext = {
  relay_stop_diagnostic_version: 1;
  relay_stop_error_kind: string;
  relay_stop_http_status: number | "none" | "other";
  relay_stop_command_exit_code: number | "none" | "other";
  relay_stop_type_error_signal?:
    "fetch_failed" | "other_type_error" | "unreadable";
  relay_stop_transport_code?: string;
} & Partial<RelayStopReceiptContext>;

// Keyed by the stop invocation's own failure, never a similar error elsewhere.
const relayStopReceipts = new WeakMap<object, RelayStopReceiptContext>();
// Version 1 has exactly five fields and version 2 exactly seven.
const RELAY_STOP_RECEIPT =
  /^relay-stop-receipt\/([12]) ([01]) ([0-4]) ([0-8]) (1[0-6]|[0-9]) (1[0-6]|[0-9])(?: ([0-6]) ([0-8]))?\n?$/;

const receiptStatus = (
  status: "absent" | "invalid" | "unreadable",
): RelayStopReceiptContext => ({
  relay_stop_receipt_version: 1,
  relay_stop_receipt_status: status,
});

/** Accept only the exact receipt written by a failing STOP program. */
function relayStopReceipt(
  exitCode: unknown,
  stdout: unknown,
): RelayStopReceiptContext {
  if (stdout === undefined || stdout === "") return receiptStatus("absent");
  // The receipt is at most 37 characters; never match against longer output.
  if (typeof stdout !== "string" || stdout.length > 64 || exitCode !== 1)
    return receiptStatus("invalid");
  const match = RELAY_STOP_RECEIPT.exec(stdout);
  if (!match || match[0].length !== stdout.length)
    return receiptStatus("invalid");
  const [version, first, stage, code, deadlines, failures] = match
    .slice(1, 7)
    .map(Number);
  const [branch, branchCode] = match.slice(7).map(Number);
  const aliveBranch =
    version === 2 && deadlines >= 1
      ? RELAY_STOP_ALIVE_BRANCHES[branch - 1]
      : undefined;
  const consistent =
    (first === 0
      ? stage === 0 && code === 0 && deadlines >= 1
      : stage >= 1 &&
        code >= 1 &&
        failures >= 1 &&
        // A failed root scan precedes every relay.
        (stage !== 1 || (deadlines === 0 && failures === 1))) &&
    (version === 1
      ? match[7] === undefined
      : match[7] !== undefined &&
        (deadlines === 0
          ? branch === 0 && branchCode === 0
          : aliveBranch !== undefined &&
            // Only error branches carry an errno code.
            (aliveBranch.endsWith("_error")
              ? branchCode >= 1
              : branchCode === 0)));
  if (!consistent) return receiptStatus("invalid");
  return {
    relay_stop_receipt_version: version === 2 ? 2 : 1,
    relay_stop_receipt_status: "recorded",
    relay_stop_first_failure: first === 0 ? "drain_deadline" : "filesystem",
    ...(first === 1 && {
      relay_stop_first_filesystem_stage: RELAY_STOP_RECEIPT_STAGES[stage - 1],
      relay_stop_first_filesystem_code: RELAY_STOP_RECEIPT_CODES[code - 1],
    }),
    relay_stop_drain_deadline_count: deadlines,
    relay_stop_filesystem_failure_count: failures,
    ...(aliveBranch !== undefined && {
      relay_stop_first_deadline_alive_branch: aliveBranch,
      ...(branchCode >= 1 && {
        relay_stop_first_deadline_alive_code:
          RELAY_STOP_RECEIPT_CODES[branchCode - 1],
      }),
    }),
  };
}

/** Read an own data property of a result; anything else throws to the caller. */
function ownResultValue(
  result: unknown,
  key: "exitCode" | "stdout" | "stderr",
) {
  if (typeof result !== "object" || result === null)
    throw new TypeError("Unreadable command result");
  const descriptor = Object.getOwnPropertyDescriptor(result, key);
  if (descriptor && !("value" in descriptor))
    throw new TypeError("Unreadable command result");
  return descriptor?.value as unknown;
}

/** Only an own numeric exit counts; accessors or unreadable results never do. */
function bridgeReportedClosed(result: unknown) {
  try {
    return ownResultValue(result, "exitCode") === BROWSER_BRIDGE_CLOSED_EXIT;
  } catch {
    return false;
  }
}

/** Record only this stop invocation's bounded receipt; never throws. */
function recordRelayStopReceipt(
  failure: object,
  result: () => { exitCode: unknown; stdout: unknown },
) {
  let receipt: RelayStopReceiptContext;
  try {
    const { exitCode, stdout } = result();
    receipt = relayStopReceipt(exitCode, stdout);
  } catch {
    receipt = receiptStatus("unreadable");
  }
  relayStopReceipts.set(failure, receipt);
}

/**
 * Project a failed relay drain from closed SDK classes and own numeric data,
 * plus any receipt validated when that stop invocation failed. Never reads
 * command output or invokes accessors, and never throws.
 */
export function browserRelayStopFailureContext(
  error: unknown,
): BrowserRelayStopFailureContext {
  try {
    const cloud = checkpointCloudErrorContext(error);
    let kind = cloud.cloud_error_kind;
    let exitCode: number | "none" | "other" = "none";
    try {
      const returnedExit =
        typeof error === "object" && error !== null
          ? returnedRelayStopExits.get(error)
          : undefined;
      if (returnedExit !== undefined) {
        kind = "command_exit";
        exitCode = returnedExit;
      } else if (error instanceof CommandExitError) {
        kind = "command_exit";
        const result = Object.getOwnPropertyDescriptor(error, "result")?.value;
        exitCode = exitStatus(
          result && typeof result === "object"
            ? Object.getOwnPropertyDescriptor(result, "exitCode")?.value
            : undefined,
        );
      } else if (error instanceof TimeoutError) kind = "timeout";
      else if (error instanceof BrowserPreviewUnavailable)
        kind = "preview_unavailable";
    } catch {
      kind = "unreadable";
      exitCode = "other";
    }
    const receipt =
      typeof error === "object" && error !== null
        ? relayStopReceipts.get(error)
        : undefined;
    return {
      relay_stop_diagnostic_version: 1,
      relay_stop_error_kind: kind,
      relay_stop_http_status: cloud.cloud_http_status,
      relay_stop_command_exit_code: exitCode,
      ...(cloud.cloud_type_error_signal === undefined
        ? {}
        : {
            relay_stop_type_error_signal: cloud.cloud_type_error_signal,
            relay_stop_transport_code: cloud.cloud_transport_code,
          }),
      ...receipt,
    };
  } catch {
    return {
      relay_stop_diagnostic_version: 1,
      relay_stop_error_kind: "unreadable",
      relay_stop_http_status: "other",
      relay_stop_command_exit_code: "other",
    };
  }
}

/** Read optional diagnostics without adding error properties to HTTP responses. */
export function browserSessionReadFailureContext(error: unknown) {
  const context =
    typeof error === "object" && error !== null
      ? sessionReadFailures.get(error)
      : undefined;
  if (!context) return undefined;
  return {
    active_session_read_diagnostic_version: 1,
    active_session_read_error_kind: context.cloud_error_kind,
    active_session_read_http_status: context.cloud_http_status,
    ...(context.cloud_type_error_signal === undefined
      ? {}
      : {
          active_session_read_type_error_signal:
            context.cloud_type_error_signal,
          active_session_read_transport_code: context.cloud_transport_code,
        }),
  };
}

const SESSION_NAME_RE = /^[^/\u0000\r\n]{1,80}$/;

type SandboxIdentityGuardReason =
  "not_running" | "user_mismatch" | "cluster_mismatch" | "template_mismatch";

// Keyed only by the identity guard's own rejection; holds the closed reason,
// never the compared metadata or the session's identifiers.
const sandboxIdentityGuardFailures = new WeakMap<
  object,
  SandboxIdentityGuardReason
>();

/** The first identity guard that refused this rejection, else nothing; never throws. */
export function browserSandboxIdentityFailureContext(error: unknown) {
  const reason =
    typeof error === "object" && error !== null
      ? sandboxIdentityGuardFailures.get(error)
      : undefined;
  if (reason === undefined) return undefined;
  return {
    sandbox_identity_guard_version: 1,
    sandbox_identity_guard_reason: reason,
  } as const;
}

/** Connect only to the exact running, user-owned cloud workspace. */
export async function connectBrowserSandbox(session: BrowserSessionLocation) {
  const region = session.triggerRegion as TriggerRunRegion | null;
  const cluster = getE2BClusterRouting(region ?? undefined).createCluster;
  const options = cluster.connectionOptions ?? {};
  let info: Awaited<ReturnType<typeof Sandbox.getInfo>>;
  try {
    info = await Sandbox.getInfo(session.sandboxId, {
      ...options,
      requestTimeoutMs: 8_000,
    });
  } catch {
    console.warn("[browser-preview] sandbox lookup unavailable");
    throw new BrowserPreviewUnavailable("disconnected");
  }
  // The first failing guard in the original short-circuit order, with the same reads.
  const mismatch: SandboxIdentityGuardReason | undefined =
    info.state !== "running"
      ? "not_running"
      : info.metadata?.userID !== session.userId
        ? "user_mismatch"
        : // Older reusable sandboxes predate cluster metadata. The selected E2B
          // account and endpoint still bind discovery to the intended region.
          info.metadata?.e2bCluster != null &&
            info.metadata.e2bCluster !== cluster.cluster
          ? "cluster_mismatch"
          : info.metadata?.template !== cluster.template
            ? "template_mismatch"
            : undefined;
  if (mismatch !== undefined) {
    console.warn("[browser-preview] sandbox identity mismatch");
    const unavailable = new BrowserPreviewUnavailable("disconnected");
    sandboxIdentityGuardFailures.set(unavailable, mismatch);
    throw unavailable;
  }
  return Sandbox.connect(session.sandboxId, {
    ...options,
    timeoutMs: 60_000,
    requestTimeoutMs: 8_000,
  });
}

/** Keep SDK read failures as loading; expose only bounded diagnostics to the owning GET. */
export async function getActiveBrowserSessionName(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
) {
  let name: string;
  try {
    name = (
      await sandbox.files.read(`${session.directory}/active-session`, {
        user: "root",
        requestTimeoutMs: 8_000,
      })
    ).trim();
  } catch (error) {
    const unavailable = new BrowserPreviewUnavailable("loading");
    sessionReadFailures.set(unavailable, checkpointCloudErrorContext(error));
    throw unavailable;
  }
  if (!SESSION_NAME_RE.test(name))
    throw new BrowserPreviewUnavailable("closed");
  return name;
}

/**
 * A rejected status command: the SDK returned no process-start handle (start),
 * or returned one whose wait then failed (wait). Acknowledgement latency is not
 * spawn time, and neither phase identifies a provider or daemon cause.
 */
type StatusCommandRejection = {
  error: unknown;
  phase: "start" | "wait";
  startAckMs?: number;
  progress?: StatusWaitProgress;
  timeoutOrigin?: StatusWaitTimeoutOrigin;
};

/**
 * The pinned E2B SDK's own static texts, each appended after ": " to a private
 * transport message when it constructs a TimeoutError. Only these exact
 * endings are compared; the prefix is never parsed or emitted.
 */
const SDK_WAIT_TIMEOUT_SUFFIXES = {
  // ConnectRPC DeadlineExceeded: the request's own command execution deadline.
  rpc_deadline:
    ": This error is likely due to exceeding 'timeoutMs' — the total time a long running request (like command execution or directory watch) can be active. It can be modified by passing 'timeoutMs' when making the request. Use '0' to disable the timeout.",
  // ConnectRPC Canceled: the SDK's requestTimeoutMs hint.
  rpc_canceled:
    ": This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
  // ConnectRPC Unavailable: the SDK's sandbox lifetime hint.
  sandbox_unavailable:
    ": This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
  // A dropped stream whose SDK health check then reported the sandbox gone.
  sandbox_gone:
    ": The sandbox was killed or reached its end of life while the request was in flight.",
} as const;

type StatusWaitTimeoutOrigin =
  keyof typeof SDK_WAIT_TIMEOUT_SUFFIXES | "unclassified";

/**
 * Which pinned-SDK TimeoutError text ends this rejection's own message data: a
 * hint about the SDK's mapping, not a cause, and no proof the helper or daemon
 * did or did not run. Any other TimeoutError (modified, compacted, accessor or
 * non-string message) is unclassified; any other value is unmeasured.
 */
function statusWaitTimeoutOrigin(
  error: unknown,
): StatusWaitTimeoutOrigin | undefined {
  if (!(error instanceof TimeoutError)) return undefined;
  let message: unknown;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, "message");
    if (descriptor && "value" in descriptor) message = descriptor.value;
  } catch {
    return "unclassified";
  }
  if (typeof message !== "string") return "unclassified";
  for (const [origin, suffix] of Object.entries(SDK_WAIT_TIMEOUT_SUFFIXES))
    if (message.endsWith(suffix)) return origin as StatusWaitTimeoutOrigin;
  return "unclassified";
}

type StatusProgressLabel =
  | (typeof BROWSER_DAEMON_PROGRESS_SEQUENCES)[keyof typeof BROWSER_DAEMON_PROGRESS_SEQUENCES]
  | "unrecognized"
  | "unreadable";
type StatusElapsedLabel =
  "lt1s" | "lt3s" | "lt6s" | "lt7s" | "gte7s" | "unmeasured";
type StatusWaitProgress = `${StatusProgressLabel}:${StatusElapsedLabel}`;

const monotonicNow = () => {
  try {
    return performance.now();
  } catch {
    return undefined;
  }
};

/**
 * The opted-in helper's delivered progress before this handle's wait rejected,
 * plus coarse total elapsed from before the start request to that rejection
 * (not acknowledgement, daemon or exit time). Only an exact complete frame
 * sequence counts; output is never retained, and nothing proves undelivered
 * frames were not written. Never throws.
 */
function statusWaitProgress(
  readStderr: () => unknown,
  startedAt: number | undefined,
  rejectedAt: number | undefined,
): StatusWaitProgress {
  let label: StatusProgressLabel = "unreadable";
  try {
    const stderr = readStderr();
    if (typeof stderr === "string") {
      label = "unrecognized";
      // At most four six-character frames; never match against longer output.
      if (stderr.length <= 24 && BROWSER_DAEMON_PROGRESS_FRAMES.test(stderr)) {
        let letters = "";
        for (let index = 4; index < stderr.length; index += 6)
          letters += stderr[index];
        if (Object.hasOwn(BROWSER_DAEMON_PROGRESS_SEQUENCES, letters))
          label =
            BROWSER_DAEMON_PROGRESS_SEQUENCES[
              letters as keyof typeof BROWSER_DAEMON_PROGRESS_SEQUENCES
            ];
      }
    }
  } catch {
    label = "unreadable";
  }
  const elapsed =
    typeof startedAt === "number" && typeof rejectedAt === "number"
      ? rejectedAt - startedAt
      : Number.NaN;
  return `${label}:${
    !Number.isFinite(elapsed) || elapsed < 0
      ? "unmeasured"
      : elapsed < 1_000
        ? "lt1s"
        : elapsed < 3_000
          ? "lt3s"
          : elapsed < 6_000
            ? "lt6s"
            : elapsed < 7_000
              ? "lt7s"
              : "gte7s"
  }`;
}

/**
 * Only a non-fresh preview passes ownedListener: the helper may then return a
 * port its daemon provably listens on without waiting behind serialized daemon
 * work, and otherwise sends this same status request. Only a fresh passive
 * preview may request WAIT or OPEN deferral. The helper's corresponding
 * literal rejects with BrowserPreviewRefreshDeferred.
 * Independently, only the Browser Preview GET passes recognizeClosed: an absent
 * owned socket with the wrapper's verified close of the still-current selection
 * then rejects with the existing closed state instead of the missing-socket exit.
 * Only that GET also passes observeProgress with onRejected: the helper then
 * writes fixed stderr progress frames, read only after this handle's wait
 * rejects without an exit, and that rejection's SDK timeout origin is projected.
 */
export async function getPrivateStreamPort(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  ownedListener = false,
  onRejected?: (rejection: StatusCommandRejection) => void,
  deferDuringWait = false,
  recognizeClosed = false,
  observeProgress = false,
  deferDuringOpen = false,
) {
  const observed = observeProgress && onRejected !== undefined;
  const closed: { recognize_closed?: true; observe_progress?: true } = {
    ...(recognizeClosed && { recognize_closed: true }),
    ...(observed && { observe_progress: true }),
  };
  const deferOpen = deferDuringOpen && !ownedListener;
  const command = browserDaemonCommand(
    session.directory,
    browserSessionName,
    ownedListener
      ? { action: "stream_status", owned_port: true, ...closed }
      : {
          action: "stream_status",
          ...(deferDuringWait && { defer_wait: true as const }),
          ...(deferOpen && { defer_open: true as const }),
          ...closed,
        },
  );
  const options = { ...buildSandboxCommandOptions(sandbox), timeoutMs: 7_000 };
  let result: CommandResult;
  if (!onRejected) result = await sandbox.commands.run(command, options);
  else {
    // The SDK's foreground run is exactly this start then the same handle's
    // wait: one request, deadline, handshake timer and signal, no new timer.
    const report = (rejection: StatusCommandRejection) => {
      try {
        onRejected(rejection);
      } catch {
        /* Observers cannot replace the SDK rejection. */
      }
    };
    const startedAt = monotonicNow();
    let handle: CommandHandle;
    try {
      handle = await sandbox.commands.run(command, {
        ...options,
        background: true,
      });
    } catch (error) {
      report({ error, phase: "start" });
      throw error;
    }
    const acknowledgedAt = monotonicNow();
    try {
      result = await handle.wait();
    } catch (error) {
      let progress: StatusWaitProgress | undefined;
      try {
        // A delivered exit is authoritative; only an SDK-only rejection.
        if (observed && !(error instanceof CommandExitError))
          progress = statusWaitProgress(
            () => handle.stderr,
            startedAt,
            monotonicNow(),
          );
      } catch {
        /* Optional progress cannot replace the SDK rejection. */
      }
      let timeoutOrigin: StatusWaitTimeoutOrigin | undefined;
      try {
        // The same opt-in; a delivered exit is never a TimeoutError.
        if (observed) timeoutOrigin = statusWaitTimeoutOrigin(error);
      } catch {
        /* An unreadable value omits only this hint. */
      }
      report({
        error,
        phase: "wait",
        ...(typeof startedAt === "number" &&
          typeof acknowledgedAt === "number" && {
            startAckMs: acknowledgedAt - startedAt,
          }),
        ...(progress !== undefined && { progress }),
        ...(timeoutOrigin !== undefined && { timeoutOrigin }),
      });
      throw error;
    }
  }
  if (result.exitCode !== 0) throw new BrowserPreviewUnavailable("closed");
  // Only the requested helper-only literals; never a parsed daemon reply field.
  if (recognizeClosed && result.stdout === BROWSER_DAEMON_SESSION_CLOSED)
    throw new BrowserPreviewUnavailable("closed");
  if (
    deferDuringWait &&
    !ownedListener &&
    result.stdout === BROWSER_DAEMON_WAIT_DEFERRED
  )
    throw new BrowserPreviewRefreshDeferred();
  if (deferOpen && result.stdout === BROWSER_DAEMON_OPEN_DEFERRED)
    throw new BrowserPreviewRefreshDeferred("open");
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    throw new BrowserPreviewUnavailable("disconnected");
  }
  const data = (
    parsed.data && typeof parsed.data === "object" ? parsed.data : parsed
  ) as Record<string, unknown>;
  const port = data.port;
  if (data.connected === false) throw new BrowserPreviewUnavailable("closed");
  if (
    !Number.isInteger(port) ||
    (port as number) < 1 ||
    (port as number) > 65535
  )
    throw new BrowserPreviewUnavailable("loading");
  return port as number;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const relayDirectory = (session: BrowserSessionLocation, grant: string) =>
  `${session.directory}/relay-${createHash("sha256").update(grant).digest("hex").slice(0, 24)}`;

export async function startBrowserRelay(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  grant: string,
  origin: string,
  streamPort?: number,
) {
  const port =
    streamPort ??
    (await getPrivateStreamPort(sandbox, session, browserSessionName));
  const handle = await sandbox.commands.run(
    `node -e ${quote(RELAY_START_PROGRAM)}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      background: true,
      stdin: true,
      timeoutMs: 8000,
    },
  );
  await handle.sendStdin(
    JSON.stringify({
      directory: relayDirectory(session, grant),
      config: {
        root: session.directory,
        port,
        browserSessionName,
        grant,
        origin,
        expiresAt: session.expiresAt,
      },
      program: browserRelayProgram(),
      // Expires before the eventual database grant, even if startup is slow.
      lease: Date.now() + 25_000,
    }),
  );
  await handle.closeStdin();
  const result = await handle.wait();
  const relayPort = Number(result.stdout.trim());
  if (
    result.exitCode !== 0 ||
    !Number.isInteger(relayPort) ||
    relayPort < 1 ||
    relayPort > 65535
  )
    throw new BrowserPreviewUnavailable("disconnected");
  return `https://${sandbox.getHost(relayPort)}`;
}

/**
 * Renew an existing relay lease. The route keeps its recovery response for
 * every rejection, while diagnostics can read the inline command's exit code.
 */
export async function renewBrowserRelay(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  grant: string,
  lease: number,
) {
  const directory = relayDirectory(session, grant);
  // Atomic replacement avoids a transient empty lease read in the relay.
  const result = await sandbox.commands.run(
    `node -e ${quote(RELAY_RENEW_PROGRAM)} ${quote(directory)} ${lease}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 5000,
    },
  );
  if (result.exitCode !== 0) {
    const unavailable = new BrowserPreviewUnavailable("disconnected");
    returnedRelayRenewExits.set(unavailable, result.exitCode);
    throw unavailable;
  }
}

export async function stopBrowserRelays(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  grant?: string,
) {
  // A permanent tombstone prevents a late heartbeat from resurrecting control.
  // Wait for the stream close handshake to drain accepted input before resume.
  let result: Awaited<ReturnType<Sandbox["commands"]["run"]>>;
  try {
    result = await sandbox.commands.run(
      `node -e ${quote(RELAY_STOP_PROGRAM)} ${quote(session.directory)}${grant ? ` ${quote(relayDirectory(session, grant))}` : ""}`,
      {
        ...buildSandboxCommandOptions(sandbox),
        timeoutMs: 7000,
      },
    );
  } catch (error) {
    try {
      if (error instanceof CommandExitError)
        recordRelayStopReceipt(error, () => {
          // The SDK stores CommandResult as own data; never invoke its getters.
          const descriptor = Object.getOwnPropertyDescriptor(error, "result");
          if (!descriptor || !("value" in descriptor))
            throw new TypeError("Unreadable command result");
          return {
            exitCode: ownResultValue(descriptor.value, "exitCode"),
            stdout: ownResultValue(descriptor.value, "stdout"),
          };
        });
    } catch {
      // Optional diagnostics cannot replace the original rejection.
    }
    throw error;
  }
  const exitCode = result.exitCode;
  if (exitCode !== 0) {
    const unavailable = new BrowserPreviewUnavailable("disconnected");
    returnedRelayStopExits.set(unavailable, exitStatus(exitCode));
    recordRelayStopReceipt(unavailable, () => ({
      exitCode,
      stdout: ownResultValue(result, "stdout"),
    }));
    throw unavailable;
  }
}

type FrameDecodeDiagnostic = {
  capture_frame_decode_version?: 1;
  capture_frame_stdout_size?:
    "empty" | "lt1k" | "1k_lt64k" | "64k_lt1m" | "gte1m" | "nonstring";
  capture_frame_stdout_shape?:
    | "empty"
    | "edge_whitespace"
    | "object_edges"
    | "object_prefix"
    | "other"
    | "nonstring";
  capture_frame_parse_error_kind?: "syntax_error" | "other";
};

/** Inspect only length and two 64-unit edges; never retain frame contents. */
function frameDecodeDiagnostic(
  stdout: unknown,
  error: unknown,
): FrameDecodeDiagnostic {
  const result: FrameDecodeDiagnostic = {
    capture_frame_decode_version: 1,
    capture_frame_parse_error_kind:
      error instanceof SyntaxError ? "syntax_error" : "other",
  };
  if (typeof stdout !== "string")
    return {
      ...result,
      capture_frame_stdout_size: "nonstring",
      capture_frame_stdout_shape: "nonstring",
    };
  const length = stdout.length;
  const first = stdout.slice(0, 64).trimStart();
  const last = stdout.slice(-64).trimEnd();
  return {
    ...result,
    capture_frame_stdout_size:
      length === 0
        ? "empty"
        : length < 1024
          ? "lt1k"
          : length < 65536
            ? "1k_lt64k"
            : length < 1048576
              ? "64k_lt1m"
              : "gte1m",
    capture_frame_stdout_shape:
      length === 0
        ? "empty"
        : !first && !last
          ? "edge_whitespace"
          : first.startsWith("{")
            ? last.endsWith("}")
              ? "object_edges"
              : "object_prefix"
            : "other",
  };
}

type FrameCaptureDiagnostic = FrameDecodeDiagnostic &
  BrowserBridgeFailureContext;

export type BrowserCaptureFailureContext = FrameCaptureDiagnostic & {
  capture_stage:
    | "stream_status"
    | "frame_bridge"
    | "frame_decode"
    | "frame_validation"
    | "fresh_screenshot"
    | "fresh_stat"
    | "fresh_read"
    | "fresh_validation";
  capture_error_kind:
    | "command_exit"
    | "timeout"
    | "preview_unavailable"
    | "other_error"
    | "thrown_value"
    | "unreadable";
  capture_command_exit_code: number | "none" | "other";
  capture_precondition_reason?: (typeof BROWSER_DAEMON_PRECONDITION_REASONS)[number];
  capture_precondition_error?:
    "missing" | "permission" | "not_directory" | "other";
  capture_deadline_diagnostic_version?: 1;
  capture_deadline_phase?: (typeof BROWSER_DAEMON_DEADLINE_PHASES)[number];
  // Daemon exit5 only: which check refused the first response line, not a cause.
  // Absent means unmeasured (older writer or budget).
  capture_response_diagnostic_version?: 1;
  capture_response_validation?: (typeof BROWSER_DAEMON_RESPONSE_VALIDATIONS)[number];
  // Fresh screenshot success_false only: the error's fixed upstream message
  // family, not a transport, errno or cause. Absent means unmeasured.
  capture_screenshot_refusal_version?: 1;
  capture_screenshot_refusal?: (typeof BROWSER_DAEMON_SCREENSHOT_REFUSALS)[number];
  capture_cli_at_prepare_diagnostic_version?: 1;
  capture_cli_at_prepare_status?: (typeof BROWSER_CLI_AT_PREPARE_STATUSES)[number];
  capture_cli_at_prepare_major?: number;
  capture_cli_at_prepare_minor?: number;
  capture_cli_at_prepare_patch?: number;
  capture_wrapper_receipt_version?: 1;
  capture_wrapper_action?: (typeof BROWSER_WRAPPER_ACTIONS)[number];
  capture_wrapper_phase?: "started" | "completed";
  capture_wrapper_exit_code?: number | "none" | "other";
  capture_wrapper_session_matches?: boolean;
  capture_wrapper_age?: (typeof BROWSER_WRAPPER_AGES)[number];
  // Selected-session STARTED wrapper only; visibility is not execution or health.
  capture_wrapper_process_version?: 1;
  capture_wrapper_process_visibility?: (typeof BROWSER_WRAPPER_PROCESS_VISIBILITIES)[number];
  // Declared first-verb category of that latest command, not the daemon's active
  // command or a cause. Absent means unmeasured (older writer or budget).
  capture_wrapper_command_version?: 1;
  capture_wrapper_command_class?: (typeof BROWSER_WRAPPER_COMMAND_CLASSES)[number];
  // Selected session only: its latest returned wrapped CLI process (the receipt's
  // own wrapper when COMPLETED, the immediately preceding one when STARTED) and its
  // wrapper-measured elapsed bucket. Not a compound shell result, daemon/CDP state
  // or capture cause. Absent means unmeasured (older writer, budget, or a preceding
  // wrapper that ended without a completion record or for another session).
  capture_wrapper_result_version?: 1;
  capture_wrapper_result_scope?: "latest_wrapper" | "previous_wrapper";
  capture_wrapper_result?: (typeof BROWSER_WRAPPER_RESULTS)[number];
  capture_wrapper_result_elapsed?: (typeof BROWSER_WRAPPER_RESULT_ELAPSED)[number];
  capture_wrapper_history_version?: 1;
  capture_wrapper_history_scope?: "handoff_root";
  // Other than a recognized version-only invocation; leading options stay ambiguous.
  capture_wrapper_other_cli_completed?: boolean;
  capture_wrapper_option_prefix_completed?: boolean;
  capture_open_receipt_version?: 1;
  capture_open_receipt_status?:
    "unavailable" | "not_observed" | "unreadable" | "recorded";
  capture_open_phase?: "started" | "completed";
  capture_open_exit_code?: number | "none" | "other";
  capture_open_session_matches?: boolean;
  capture_open_age?: (typeof BROWSER_WRAPPER_AGES)[number];
  capture_open_idle_env_version?: 1;
  capture_open_idle_env?: (typeof BROWSER_OPEN_IDLE_ENV_VALUES)[number];
  capture_daemon_process_version?: 1;
  capture_daemon_pid_status?: "missing" | "invalid" | "unreadable" | "recorded";
  // A PID can be reused; this is not daemon identity, execution or health.
  capture_daemon_process_visibility?:
    | "unavailable"
    | "not_found"
    | "same_uid"
    | "other_uid"
    | "permission"
    | "other";
  // Selected socket when that matching OPEN returned 0, not at capture time.
  // Absent means unmeasured (older writer or budget), never missing.
  capture_open_socket_return_version?: 1;
  capture_open_socket_return_status?: (typeof BROWSER_OPEN_SOCKET_RETURN_STATUSES)[number];
  // Exact help/version tokens declared in that matching OPEN's arguments; not
  // its effective CLI result or daemon state. Absent means unmeasured, never none.
  capture_open_info_version?: 1;
  capture_open_info_flags?: (typeof BROWSER_OPEN_INFO_FLAGS)[number];
  // Status exit2 socket_stat missing only, beside that matching OPEN's missing
  // at-return socket and no informational tokens: its own AGENT_BROWSER_SOCKET_DIR
  // declaration class. Never the value or effective routing; absent is unmeasured.
  capture_open_socket_directory_v1?: (typeof BROWSER_OPEN_SOCKET_DIRECTORY_DECLARATIONS)[number];
  // The selected daemon's .version sidecar declaration beside that matching OPEN's
  // socket; not a verified daemon version, identity or health. Absent is unmeasured.
  capture_daemon_version_file_version?: 1;
  capture_daemon_version_file_status?: (typeof BROWSER_DAEMON_VERSION_FILE_STATUSES)[number];
  capture_daemon_version_file_major?: number;
  capture_daemon_version_file_minor?: number;
  capture_daemon_version_file_patch?: number;
  // Exit3 awaiting_response beside that matching successful OPEN, or beside the same
  // selected plain OPEN whose exact wrapper is still started and visible: selected-path stream
  // connections visible beside the selected daemon's own listener at the deadline,
  // sampled before the helper closes its own connection, so they may include it;
  // each saturated at 15. Pending were not yet accepted;
  // held are accepted connections that daemon PID holds. Not request acceptance,
  // the lock holder, Chromium state or a cause. Absent is unmeasured.
  capture_daemon_socket_queue_version?: 1;
  capture_daemon_socket_pending_count?: number;
  capture_daemon_socket_held_count?: number;
  // Fresh screenshot only, beside that queue for the still-started plain OPEN: whether
  // that OPEN's wrapper STARTED record precedes or follows the screenshot helper's local
  // write attempt on the same guest's millisecond clock. Not daemon receipt or order,
  // file state or a cause; a sent screenshot can still write after cleanup. Absent is
  // unmeasured (older helper, tie, budget or any other stage).
  capture_open_start_write_order_v1?: "before_write" | "after_write";
  // Opted-in passive status only, beside that queue for the still-started plain OPEN
  // with exactly one held and at least one pending connection: whether that held
  // connection's inode was already held in one sample taken before the helper connected
  // (same socket, daemon PID, listener and OPEN invocation). Not which client it is,
  // request acceptance or a cause. Absent is unmeasured (older helper, any unverified
  // sample, other counts, budget or any other stage).
  capture_open_preconnect_held_v1?: "present" | "absent";
  // Opted-in passive status only, beside that queue for the matching successful OPEN
  // with none pending and at least two held: the selected session's live STARTED other
  // wrapper (its exact incarnation, reread after the sample) declared a plain eval.
  // A declaration, not the daemon's active command, its progress or a cause. Absent is
  // unmeasured (older writer or helper, any other argv, count or stage, or budget).
  capture_active_other_command_v1?: "eval";
  capture_close_receipt_version?: 1;
  capture_close_receipt_status?:
    "unavailable" | "not_observed" | "unreadable" | "recorded";
  capture_close_phase?: "started" | "completed";
  capture_close_exit_code?: number | "none" | "other";
  capture_close_scope?: "selected_session" | "other_session" | "all_sessions";
  capture_close_age?: (typeof BROWSER_WRAPPER_AGES)[number];
  capture_close_open_order?: "after" | "before" | "same_time" | "unavailable";
  // Status exit2 socket_stat missing only, for the Browser Preview GET's own fresh
  // recognizeClosed lookup: the first check of the existing close-proof verification
  // that refused it. Proves neither that a close ran nor its absence, and is no cause.
  // Absent is unmeasured (older helper, budget or an unclassified error).
  capture_close_proof_failure_v1?: (typeof BROWSER_CLOSE_PROOF_FAILURES)[number];
  // Stream-status SDK rejection without an exit only: start means no process
  // handle was returned; wait means one was, with its acknowledgement latency.
  capture_sdk_command_diagnostic_version?: 1;
  capture_sdk_command_phase?: "start" | "wait";
  capture_sdk_start_ack_latency?: "lt1s" | "lt3s" | "lt6s" | "gte6s";
  // Opted-in GET wait rejection only: "<helper progress>:<total elapsed>". The
  // exact helper frame sequence delivered to this handle: entry, socket path,
  // local write-attempt boundary (not daemon receipt) and helper-selected
  // disposition (not actual exit delivery). Frames can be dropped, so
  // none_delivered or unrecognized/unreadable output never proves the helper
  // did not run. Elapsed is from before the start request, not acknowledgement.
  capture_sdk_wait_progress_v1?: StatusWaitProgress;
  // Same opted-in GET wait rejection, SDK TimeoutError only: which pinned-SDK
  // static text ends its message (deadline, canceled, unavailable, or a health
  // check reporting the sandbox gone mid-request); unclassified for any other
  // TimeoutError. A hint about the SDK's error family, not a cause.
  capture_sdk_wait_timeout_origin_v1?: StatusWaitTimeoutOrigin;
  // Fresh_read only: the SDK read call or converting its result, with the SDK
  // projection only for sdk_read. Absent means unmeasured (other stages, older
  // builds, or a cleanup exception that replaced the failure), never none.
  capture_fresh_read_diagnostic_version?: 1;
  capture_fresh_read_phase?: "sdk_read" | "bytes_convert";
  capture_fresh_read_error_kind?: string;
  capture_fresh_read_http_status?: number | "none" | "other";
  capture_fresh_read_type_error_signal?:
    "fetch_failed" | "other_type_error" | "unreadable";
  capture_fresh_read_transport_code?: string;
};

/** The whole version-1 group; only an SDK read carries the bounded SDK labels. */
function freshReadContext(
  phase: "sdk_read" | "bytes_convert",
  error: unknown,
): Pick<
  BrowserCaptureFailureContext,
  Extract<keyof BrowserCaptureFailureContext, `capture_fresh_read_${string}`>
> {
  const group = {
    capture_fresh_read_diagnostic_version: 1,
    capture_fresh_read_phase: phase,
  } as const;
  if (phase === "bytes_convert") return group;
  const cloud = checkpointCloudErrorContext(error);
  return {
    ...group,
    capture_fresh_read_error_kind: cloud.cloud_error_kind,
    capture_fresh_read_http_status: cloud.cloud_http_status,
    ...(cloud.cloud_type_error_signal === undefined
      ? {}
      : {
          capture_fresh_read_type_error_signal: cloud.cloud_type_error_signal,
          capture_fresh_read_transport_code: cloud.cloud_transport_code,
        }),
  };
}

/** The whole version-1 group, or nothing when a wait latency is unusable. */
function statusSdkPhaseContext({
  phase,
  startAckMs,
}: StatusCommandRejection): Pick<
  BrowserCaptureFailureContext,
  | "capture_sdk_command_diagnostic_version"
  | "capture_sdk_command_phase"
  | "capture_sdk_start_ack_latency"
> {
  if (phase === "start")
    return {
      capture_sdk_command_diagnostic_version: 1,
      capture_sdk_command_phase: "start",
    };
  if (
    phase !== "wait" ||
    typeof startAckMs !== "number" ||
    !Number.isFinite(startAckMs) ||
    startAckMs < 0
  )
    return {};
  return {
    capture_sdk_command_diagnostic_version: 1,
    capture_sdk_command_phase: "wait",
    capture_sdk_start_ack_latency:
      startAckMs < 1_000
        ? "lt1s"
        : startAckMs < 3_000
          ? "lt3s"
          : startAckMs < 6_000
            ? "lt6s"
            : "gte6s",
  };
}

/**
 * Capture a validated frame, requesting a separate screenshot when freshness is required.
 * The optional failure observer receives only bounded context; observer failures
 * cannot replace the original rejection or change capture, cleanup, or retry behavior.
 * Only the passive preview GET opts into deferDuringWait for a fresh capture that
 * looks up its own port; its status or later screenshot may then reject with
 * BrowserPreviewRefreshDeferred, which is not a capture failure, returns no
 * frame and reaches no observer. Without verified WAIT and listener proof the
 * original strict capture runs unchanged. That GET may independently opt into
 * deferDuringOpen for the same fresh own-port capture: only its status lookup
 * (never the fresh screenshot) may then reject with
 * BrowserPreviewRefreshDeferred("open") at the unchanged deadline. Only that GET
 * also opts into recognizeClosed when it looks up its own port: a verified close
 * of the absent selected socket, at status or during the fresh screenshot,
 * then rejects with the existing closed state.
 * With onFailure, only that GET opts into observeStatusProgress for its own
 * port lookup, adding one bounded progress field to an SDK wait rejection,
 * plus a closed origin hint when that rejection is an SDK TimeoutError.
 */
export async function captureBrowserFrame(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  requireFresh = false,
  streamPort?: number,
  onFailure?: (context: BrowserCaptureFailureContext) => void,
  options?: {
    deferDuringWait?: boolean;
    deferDuringOpen?: boolean;
    recognizeClosed?: boolean;
    observeStatusProgress?: boolean;
  },
) {
  let stage: BrowserCaptureFailureContext["capture_stage"] = "stream_status";
  let decodeDiagnostic: FrameDecodeDiagnostic = {};
  let returnedBridgeFailure: unknown;
  let statusRejection: StatusCommandRejection | undefined;
  let freshReadPhase: "sdk_read" | "bytes_convert" | undefined;
  const deferDuringWait =
    requireFresh &&
    streamPort === undefined &&
    options?.deferDuringWait === true;
  const deferDuringOpen =
    requireFresh &&
    streamPort === undefined &&
    options?.deferDuringOpen === true;
  // Also exactly the own status lookup that opts in without owned_port.
  const screenshotRecognizesClosed =
    requireFresh &&
    streamPort === undefined &&
    options?.recognizeClosed === true;
  try {
    const port =
      streamPort ??
      (await getPrivateStreamPort(
        sandbox,
        session,
        browserSessionName,
        !requireFresh,
        onFailure &&
          ((rejection) => {
            statusRejection = rejection;
          }),
        deferDuringWait,
        options?.recognizeClosed === true,
        options?.observeStatusProgress === true,
        deferDuringOpen,
      ));
    stage = "frame_bridge";
    const result = await sandbox.commands.run(
      browserBridgeCommand(port, "frame"),
      {
        ...buildSandboxCommandOptions(sandbox),
        timeoutMs: 8_000,
      },
    );
    if (result.exitCode !== 0) {
      returnedBridgeFailure = result;
      throw new BrowserPreviewUnavailable(
        bridgeReportedClosed(result) ? "closed" : "disconnected",
      );
    }
    let frame: {
      data: string;
      width: number;
      height: number;
      capturedAt: number;
    };
    stage = "frame_decode";
    let stdout: unknown;
    try {
      stdout = result.stdout;
      frame = JSON.parse(stdout as string) as typeof frame;
    } catch (error) {
      try {
        decodeDiagnostic = frameDecodeDiagnostic(stdout, error);
      } catch {
        /* Optional diagnostics cannot replace the existing capture failure. */
      }
      throw new BrowserPreviewUnavailable("disconnected");
    }
    stage = "frame_validation";
    if (
      typeof frame.data !== "string" ||
      frame.data.length > 900_000 ||
      !Number.isFinite(frame.width) ||
      !Number.isFinite(frame.height) ||
      frame.width < 1 ||
      frame.height < 1 ||
      !Number.isFinite(frame.capturedAt)
    )
      throw new BrowserPreviewUnavailable("disconnected");
    const image = Buffer.from(frame.data, "base64");
    if (image.byteLength < 4 || image.byteLength > 675_000)
      throw new BrowserPreviewUnavailable("disconnected");
    const mime =
      image[0] === 0xff && image[1] === 0xd8
        ? "image/jpeg"
        : image[0] === 0x89 && image[1] === 0x50
          ? "image/png"
          : null;
    if (!mime) throw new BrowserPreviewUnavailable("disconnected");
    let imageUrl = `data:${mime};base64,${frame.data}`;
    let capturedAt = frame.capturedAt;
    if (requireFresh) {
      // agent-browser 0.26 can replay cached frames with timestamp=0. A new
      // screenshot proves freshness without assigning a new age to that cache.
      const path = `${session.directory}/preview-${randomBytes(16).toString("hex")}.jpg`;
      capturedAt = Date.now();
      // A WAIT can start after status answered; the same opt-in lets the
      // screenshot yield to it, and the helper otherwise sends it unchanged.
      let screenshotDeferred = false;
      try {
        stage = "fresh_screenshot";
        const screenshot = await sandbox.commands.run(
          browserDaemonCommand(session.directory, browserSessionName, {
            action: "screenshot",
            path,
            format: "jpeg",
            quality: 65,
            ...(deferDuringWait && { defer_wait: true as const }),
            ...(screenshotRecognizesClosed && {
              recognize_closed: true as const,
            }),
          }),
          {
            ...buildSandboxCommandOptions(sandbox),
            timeoutMs: 8_000,
          },
        );
        if (screenshot.exitCode !== 0)
          throw new BrowserPreviewUnavailable("disconnected");
        // The selected session closed after status answered. The daemon may
        // already have written the file, so the cleanup below still runs.
        if (
          screenshotRecognizesClosed &&
          screenshot.stdout === BROWSER_DAEMON_SESSION_CLOSED
        )
          throw new BrowserPreviewUnavailable("closed");
        // Only the requested helper-only literal; never a parsed daemon reply field.
        if (
          deferDuringWait &&
          screenshot.stdout === BROWSER_DAEMON_WAIT_DEFERRED
        ) {
          // The helper sent no screenshot, so no file can exist to remove.
          screenshotDeferred = true;
          throw new BrowserPreviewRefreshDeferred();
        }
        stage = "fresh_stat";
        const info = await sandbox.files.getInfo(path, {
          user: "root",
          requestTimeoutMs: 4_000,
        });
        if (info.size < 4 || info.size > 675_000)
          throw new BrowserPreviewUnavailable("disconnected");
        stage = "fresh_read";
        freshReadPhase = "sdk_read";
        const bytes = await sandbox.files.read(path, {
          format: "bytes",
          user: "root",
          requestTimeoutMs: 4_000,
        });
        freshReadPhase = "bytes_convert";
        const fresh = Buffer.from(bytes);
        stage = "fresh_validation";
        if (
          fresh.byteLength < 4 ||
          fresh.byteLength > 675_000 ||
          fresh[0] !== 0xff ||
          fresh[1] !== 0xd8
        )
          throw new BrowserPreviewUnavailable("disconnected");
        imageUrl = `data:image/jpeg;base64,${fresh.toString("base64")}`;
      } finally {
        // The private memory-backed run directory is also erased at run cleanup.
        if (!screenshotDeferred) {
          try {
            await sandbox.files
              .remove(path, { user: "root", requestTimeoutMs: 4_000 })
              .catch(() => undefined);
          } catch (error) {
            // This cleanup exception replaces any read failure; never attribute it.
            freshReadPhase = undefined;
            throw error;
          }
        }
      }
    }
    return {
      image: imageUrl,
      width: frame.width,
      height: frame.height,
      capturedAt,
      browserSessionName,
    };
  } catch (error) {
    // An explicit deferral outcome, never a failure: no diagnostics or relabeling.
    if (
      error instanceof BrowserPreviewRefreshDeferred &&
      (error.reason === "open"
        ? deferDuringOpen && stage === "stream_status"
        : error.reason === "wait" &&
          deferDuringWait &&
          (stage === "stream_status" || stage === "fresh_screenshot"))
    )
      throw error;
    if (onFailure) {
      let kind: BrowserCaptureFailureContext["capture_error_kind"] =
        "unreadable";
      let code: BrowserCaptureFailureContext["capture_command_exit_code"] =
        "none";
      const precondition: Pick<
        BrowserCaptureFailureContext,
        | "capture_precondition_reason"
        | "capture_precondition_error"
        | "capture_wrapper_receipt_version"
        | "capture_wrapper_action"
        | "capture_wrapper_phase"
        | "capture_wrapper_exit_code"
        | "capture_wrapper_session_matches"
        | "capture_wrapper_age"
        | "capture_wrapper_process_version"
        | "capture_wrapper_process_visibility"
        | "capture_wrapper_command_version"
        | "capture_wrapper_command_class"
        | "capture_wrapper_result_version"
        | "capture_wrapper_result_scope"
        | "capture_wrapper_result"
        | "capture_wrapper_result_elapsed"
        | "capture_wrapper_history_version"
        | "capture_wrapper_history_scope"
        | "capture_wrapper_other_cli_completed"
        | "capture_wrapper_option_prefix_completed"
        | "capture_deadline_diagnostic_version"
        | "capture_deadline_phase"
        | "capture_response_diagnostic_version"
        | "capture_response_validation"
        | "capture_screenshot_refusal_version"
        | "capture_screenshot_refusal"
        | "capture_cli_at_prepare_diagnostic_version"
        | "capture_cli_at_prepare_status"
        | "capture_cli_at_prepare_major"
        | "capture_cli_at_prepare_minor"
        | "capture_cli_at_prepare_patch"
        | "capture_open_receipt_version"
        | "capture_open_receipt_status"
        | "capture_open_phase"
        | "capture_open_exit_code"
        | "capture_open_session_matches"
        | "capture_open_age"
        | "capture_open_idle_env_version"
        | "capture_open_idle_env"
        | "capture_daemon_process_version"
        | "capture_daemon_pid_status"
        | "capture_daemon_process_visibility"
        | "capture_open_socket_return_version"
        | "capture_open_socket_return_status"
        | "capture_open_info_version"
        | "capture_open_info_flags"
        | "capture_open_socket_directory_v1"
        | "capture_daemon_version_file_version"
        | "capture_daemon_version_file_status"
        | "capture_daemon_version_file_major"
        | "capture_daemon_version_file_minor"
        | "capture_daemon_version_file_patch"
        | "capture_daemon_socket_queue_version"
        | "capture_daemon_socket_pending_count"
        | "capture_daemon_socket_held_count"
        | "capture_open_start_write_order_v1"
        | "capture_open_preconnect_held_v1"
        | "capture_active_other_command_v1"
        | "capture_close_receipt_version"
        | "capture_close_receipt_status"
        | "capture_close_phase"
        | "capture_close_exit_code"
        | "capture_close_scope"
        | "capture_close_age"
        | "capture_close_open_order"
        | "capture_close_proof_failure_v1"
      > = {};
      try {
        if (error instanceof CommandExitError) {
          kind = "command_exit";
          // The SDK stores CommandResult as own data; never read output or invoke accessors.
          const result = Object.getOwnPropertyDescriptor(
            error,
            "result",
          )?.value;
          const value =
            result &&
            Object.getOwnPropertyDescriptor(result, "exitCode")?.value;
          code =
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= 0 &&
            value <= 255
              ? value
              : "other";
          if (
            (stage === "stream_status" || stage === "fresh_screenshot") &&
            typeof code === "number" &&
            code >= 2 &&
            code <= 6
          ) {
            // This daemon parser never sees successful images or bridge output;
            // bridge exit-6 packets have a separate strict parser below.
            // Existing context plus compact process/CLI tuples retain the 544-byte cap.
            const stdout =
              result &&
              Object.getOwnPropertyDescriptor(result, "stdout")?.value;
            if (typeof stdout === "string" && stdout.length <= 544) {
              const parsed = JSON.parse(stdout);
              const cli = parsed?.cv;
              if (
                Array.isArray(cli) &&
                cli[0] === 1 &&
                Number.isInteger(cli[1]) &&
                cli[1] >= 0 &&
                cli[1] < BROWSER_CLI_AT_PREPARE_STATUSES.length &&
                (cli[1] === 1
                  ? cli.length === 3 &&
                    Number.isInteger(cli[2]) &&
                    cli[2] >= 0 &&
                    cli[2] <= 999999999
                  : cli.length === 2)
              ) {
                precondition.capture_cli_at_prepare_diagnostic_version = 1;
                precondition.capture_cli_at_prepare_status =
                  BROWSER_CLI_AT_PREPARE_STATUSES[cli[1]];
                if (cli[1] === 1) {
                  precondition.capture_cli_at_prepare_major = Math.floor(
                    cli[2] / 1000000,
                  );
                  precondition.capture_cli_at_prepare_minor =
                    Math.floor(cli[2] / 1000) % 1000;
                  precondition.capture_cli_at_prepare_patch = cli[2] % 1000;
                }
              }
              const deadline =
                code === 3 ? daemonDeadlinePhase(parsed) : undefined;
              if (deadline) {
                precondition.capture_deadline_diagnostic_version = 1;
                precondition.capture_deadline_phase = deadline;
              }
              const validation = parsed?.r1;
              if (
                code === 5 &&
                Array.isArray(validation) &&
                validation.length === 2 &&
                validation[0] === 1 &&
                Number.isInteger(validation[1]) &&
                validation[1] >= 0 &&
                validation[1] < BROWSER_DAEMON_RESPONSE_VALIDATIONS.length
              ) {
                precondition.capture_response_diagnostic_version = 1;
                precondition.capture_response_validation =
                  BROWSER_DAEMON_RESPONSE_VALIDATIONS[validation[1]];
              }
              const refusal = parsed?.s1;
              if (
                stage === "fresh_screenshot" &&
                precondition.capture_response_validation === "success_false" &&
                Array.isArray(refusal) &&
                refusal.length === 2 &&
                refusal[0] === 1 &&
                Number.isInteger(refusal[1]) &&
                refusal[1] >= 0 &&
                refusal[1] < BROWSER_DAEMON_SCREENSHOT_REFUSALS.length
              ) {
                precondition.capture_screenshot_refusal_version = 1;
                precondition.capture_screenshot_refusal =
                  BROWSER_DAEMON_SCREENSHOT_REFUSALS[refusal[1]];
              }
              const reason = parsed?.diagnostic_reason;
              if (
                code === 2 &&
                BROWSER_DAEMON_PRECONDITION_REASONS.includes(reason)
              ) {
                precondition.capture_precondition_reason = reason;
                const failure = parsed?.diagnostic_error;
                if (
                  failure === "missing" ||
                  failure === "permission" ||
                  failure === "not_directory" ||
                  failure === "other"
                )
                  precondition.capture_precondition_error = failure;
              }
              const phase = parsed?.wrapper_phase;
              const exit = parsed?.wrapper_exit;
              if (
                parsed?.wrapper_receipt_version === 1 &&
                BROWSER_WRAPPER_ACTIONS.includes(parsed.wrapper_action) &&
                (phase === "started" || phase === "completed") &&
                typeof parsed.wrapper_session_matches === "boolean" &&
                BROWSER_WRAPPER_AGES.includes(parsed.wrapper_age) &&
                (phase === "started"
                  ? exit === "none"
                  : exit === "other" ||
                    (typeof exit === "number" &&
                      Number.isInteger(exit) &&
                      exit >= 0 &&
                      exit <= 255))
              ) {
                precondition.capture_wrapper_receipt_version = 1;
                precondition.capture_wrapper_action = parsed.wrapper_action;
                precondition.capture_wrapper_phase = phase;
                precondition.capture_wrapper_exit_code = exit;
                precondition.capture_wrapper_session_matches =
                  parsed.wrapper_session_matches;
                precondition.capture_wrapper_age = parsed.wrapper_age;
              }
              const wrapperProcess = parsed?.w1;
              if (
                precondition.capture_wrapper_phase === "started" &&
                precondition.capture_wrapper_session_matches === true &&
                Number.isInteger(wrapperProcess) &&
                wrapperProcess >= 0 &&
                wrapperProcess < BROWSER_WRAPPER_PROCESS_VISIBILITIES.length
              ) {
                precondition.capture_wrapper_process_version = 1;
                precondition.capture_wrapper_process_visibility =
                  BROWSER_WRAPPER_PROCESS_VISIBILITIES[wrapperProcess];
              }
              const command = parsed?.k1;
              if (
                precondition.capture_wrapper_receipt_version === 1 &&
                Number.isInteger(command) &&
                command >= 0 &&
                command < BROWSER_WRAPPER_COMMAND_CLASSES.length
              ) {
                precondition.capture_wrapper_command_version = 1;
                precondition.capture_wrapper_command_class =
                  BROWSER_WRAPPER_COMMAND_CLASSES[command];
              }
              const wrapperResult = parsed?.l1;
              if (
                precondition.capture_wrapper_receipt_version === 1 &&
                precondition.capture_wrapper_session_matches === true &&
                Array.isArray(wrapperResult) &&
                wrapperResult.length === 3 &&
                wrapperResult[0] === 1 &&
                Number.isInteger(wrapperResult[1]) &&
                wrapperResult[1] >= 0 &&
                wrapperResult[1] < BROWSER_WRAPPER_RESULTS.length &&
                Number.isInteger(wrapperResult[2]) &&
                wrapperResult[2] >= 0 &&
                wrapperResult[2] < BROWSER_WRAPPER_RESULT_ELAPSED.length
              ) {
                precondition.capture_wrapper_result_version = 1;
                precondition.capture_wrapper_result_scope =
                  precondition.capture_wrapper_phase === "completed"
                    ? "latest_wrapper"
                    : "previous_wrapper";
                precondition.capture_wrapper_result =
                  BROWSER_WRAPPER_RESULTS[wrapperResult[1]];
                precondition.capture_wrapper_result_elapsed =
                  BROWSER_WRAPPER_RESULT_ELAPSED[wrapperResult[2]];
              }
              const history = parsed?.h1;
              if (history === 0 || history === 1 || history === 3) {
                precondition.capture_wrapper_history_version = 1;
                precondition.capture_wrapper_history_scope = "handoff_root";
                precondition.capture_wrapper_other_cli_completed =
                  (history & 1) !== 0;
                precondition.capture_wrapper_option_prefix_completed =
                  (history & 2) !== 0;
              }
              const openStatus = parsed?.open_receipt_status;
              const openPhase = parsed?.open_phase;
              const openExit = parsed?.open_exit;
              if (
                parsed?.open_receipt_version === 1 &&
                [
                  "unavailable",
                  "not_observed",
                  "unreadable",
                  "recorded",
                ].includes(openStatus) &&
                (openStatus !== "recorded" ||
                  ((openPhase === "started" || openPhase === "completed") &&
                    typeof parsed.open_session_matches === "boolean" &&
                    BROWSER_WRAPPER_AGES.includes(parsed.open_age) &&
                    (openPhase === "started"
                      ? openExit === "none"
                      : openExit === "other" ||
                        (typeof openExit === "number" &&
                          Number.isInteger(openExit) &&
                          openExit >= 0 &&
                          openExit <= 255))))
              ) {
                precondition.capture_open_receipt_version = 1;
                precondition.capture_open_receipt_status = openStatus;
                if (openStatus === "recorded") {
                  precondition.capture_open_phase = openPhase;
                  precondition.capture_open_exit_code = openExit;
                  precondition.capture_open_session_matches =
                    parsed.open_session_matches;
                  precondition.capture_open_age = parsed.open_age;
                }
              }
              const processObservation = parsed?.p1;
              if (
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_phase === "completed" &&
                precondition.capture_open_exit_code === 0 &&
                precondition.capture_open_session_matches === true &&
                Array.isArray(processObservation) &&
                processObservation.length === 3 &&
                processObservation[0] === 1 &&
                Number.isInteger(processObservation[1]) &&
                processObservation[1] >= 0 &&
                processObservation[1] <= 3 &&
                Number.isInteger(processObservation[2]) &&
                processObservation[2] >= 0 &&
                processObservation[2] <= 5 &&
                (processObservation[1] === 3 || processObservation[2] === 0)
              ) {
                precondition.capture_daemon_process_version = 1;
                precondition.capture_daemon_pid_status = (
                  ["missing", "invalid", "unreadable", "recorded"] as const
                )[processObservation[1]];
                precondition.capture_daemon_process_visibility = (
                  [
                    "unavailable",
                    "not_found",
                    "same_uid",
                    "other_uid",
                    "permission",
                    "other",
                  ] as const
                )[processObservation[2]];
              }
              const openSocket = parsed?.os1;
              if (
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_phase === "completed" &&
                precondition.capture_open_exit_code === 0 &&
                precondition.capture_open_session_matches === true &&
                Number.isInteger(openSocket) &&
                openSocket >= 0 &&
                openSocket < BROWSER_OPEN_SOCKET_RETURN_STATUSES.length
              ) {
                precondition.capture_open_socket_return_version = 1;
                precondition.capture_open_socket_return_status =
                  BROWSER_OPEN_SOCKET_RETURN_STATUSES[openSocket];
              }
              const openInfo = parsed?.o1;
              if (
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_phase === "completed" &&
                precondition.capture_open_exit_code === 0 &&
                precondition.capture_open_session_matches === true &&
                Number.isInteger(openInfo) &&
                openInfo >= 0 &&
                openInfo < BROWSER_OPEN_INFO_FLAGS.length
              ) {
                precondition.capture_open_info_version = 1;
                precondition.capture_open_info_flags =
                  BROWSER_OPEN_INFO_FLAGS[openInfo];
              }
              const socketDirectory = parsed?.sd1;
              if (
                stage === "stream_status" &&
                code === 2 &&
                precondition.capture_precondition_reason === "socket_stat" &&
                precondition.capture_precondition_error === "missing" &&
                precondition.capture_open_socket_return_status === "missing" &&
                precondition.capture_open_info_flags === "none" &&
                Number.isInteger(socketDirectory) &&
                socketDirectory >= 0 &&
                socketDirectory <
                  BROWSER_OPEN_SOCKET_DIRECTORY_DECLARATIONS.length
              )
                precondition.capture_open_socket_directory_v1 =
                  BROWSER_OPEN_SOCKET_DIRECTORY_DECLARATIONS[socketDirectory];
              // Only this request's own fresh recognizeClosed lookup, which never
              // sends owned_port; the fresh screenshot and timeouts never parse it.
              const closeProof = parsed?.cp1;
              if (
                stage === "stream_status" &&
                code === 2 &&
                screenshotRecognizesClosed &&
                precondition.capture_precondition_reason === "socket_stat" &&
                precondition.capture_precondition_error === "missing" &&
                Number.isInteger(closeProof) &&
                closeProof >= 0 &&
                closeProof < BROWSER_CLOSE_PROOF_FAILURES.length
              )
                precondition.capture_close_proof_failure_v1 =
                  BROWSER_CLOSE_PROOF_FAILURES[closeProof];
              const daemonVersion = parsed?.dv;
              if (
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_phase === "completed" &&
                precondition.capture_open_exit_code === 0 &&
                precondition.capture_open_session_matches === true &&
                Array.isArray(daemonVersion) &&
                daemonVersion[0] === 1 &&
                Number.isInteger(daemonVersion[1]) &&
                daemonVersion[1] >= 0 &&
                daemonVersion[1] <
                  BROWSER_DAEMON_VERSION_FILE_STATUSES.length &&
                (daemonVersion[1] === 1
                  ? daemonVersion.length === 3 &&
                    Number.isInteger(daemonVersion[2]) &&
                    daemonVersion[2] >= 0 &&
                    daemonVersion[2] <= 999999999
                  : daemonVersion.length === 2)
              ) {
                precondition.capture_daemon_version_file_version = 1;
                precondition.capture_daemon_version_file_status =
                  BROWSER_DAEMON_VERSION_FILE_STATUSES[daemonVersion[1]];
                if (daemonVersion[1] === 1) {
                  precondition.capture_daemon_version_file_major = Math.floor(
                    daemonVersion[2] / 1000000,
                  );
                  precondition.capture_daemon_version_file_minor =
                    Math.floor(daemonVersion[2] / 1000) % 1000;
                  precondition.capture_daemon_version_file_patch =
                    daemonVersion[2] % 1000;
                }
              }
              const queue = parsed?.q1;
              if (
                code === 3 &&
                precondition.capture_deadline_phase === "awaiting_response" &&
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_session_matches === true &&
                ((precondition.capture_open_phase === "completed" &&
                  precondition.capture_open_exit_code === 0) ||
                  // The helper also matches this OPEN to the latest wrapper's
                  // exact record and requires a plain OPEN; neither is exported.
                  (precondition.capture_open_phase === "started" &&
                    precondition.capture_wrapper_action === "open" &&
                    precondition.capture_wrapper_phase === "started" &&
                    precondition.capture_wrapper_session_matches === true &&
                    precondition.capture_wrapper_process_visibility ===
                      "same_incarnation_visible")) &&
                Array.isArray(queue) &&
                queue.length === 3 &&
                queue[0] === 1 &&
                [queue[1], queue[2]].every(
                  (count) =>
                    Number.isInteger(count) && count >= 0 && count <= 15,
                )
              ) {
                precondition.capture_daemon_socket_queue_version = 1;
                precondition.capture_daemon_socket_pending_count = queue[1];
                precondition.capture_daemon_socket_held_count = queue[2];
                // Only the still-started OPEN branch above scopes this order.
                const order = parsed?.ot1;
                if (
                  stage === "fresh_screenshot" &&
                  precondition.capture_open_phase === "started" &&
                  (order === 1 || order === 2)
                )
                  precondition.capture_open_start_write_order_v1 =
                    order === 1 ? "before_write" : "after_write";
                // Only this request's own OPEN opt-in, at its status lookup.
                const preconnectHeld = parsed?.ph1;
                if (
                  stage === "stream_status" &&
                  deferDuringOpen &&
                  precondition.capture_open_phase === "started" &&
                  queue[1] >= 1 &&
                  queue[2] === 1 &&
                  (preconnectHeld === 1 || preconnectHeld === 2)
                )
                  precondition.capture_open_preconnect_held_v1 =
                    preconnectHeld === 1 ? "present" : "absent";
                // Only this request's own OPEN opt-in, at its status lookup, beside the
                // completed OPEN branch above and the live STARTED other wrapper.
                if (
                  stage === "stream_status" &&
                  deferDuringOpen &&
                  precondition.capture_open_phase === "completed" &&
                  precondition.capture_wrapper_action === "other" &&
                  precondition.capture_wrapper_phase === "started" &&
                  precondition.capture_wrapper_session_matches === true &&
                  precondition.capture_wrapper_process_visibility ===
                    "same_incarnation_visible" &&
                  precondition.capture_wrapper_command_class === "other" &&
                  queue[1] === 0 &&
                  queue[2] >= 2 &&
                  parsed?.e1 === 1
                )
                  precondition.capture_active_other_command_v1 = "eval";
              }
              const openIdle = parsed?.open_idle;
              if (
                precondition.capture_open_receipt_status === "recorded" &&
                precondition.capture_open_session_matches === true &&
                Array.isArray(openIdle) &&
                openIdle.length === 2 &&
                openIdle[0] === 1 &&
                BROWSER_OPEN_IDLE_ENV_VALUES.includes(openIdle[1])
              ) {
                precondition.capture_open_idle_env_version = 1;
                precondition.capture_open_idle_env = openIdle[1];
              }
              const close = parsed?.close_receipt;
              if (Array.isArray(close) && close[0] === 1) {
                const [, status, phase, exit, scope, age, order] = close;
                if (
                  close.length === 2 &&
                  ["unavailable", "not_observed", "unreadable"].includes(status)
                ) {
                  precondition.capture_close_receipt_version = 1;
                  precondition.capture_close_receipt_status = status;
                } else if (
                  close.length === 7 &&
                  status === "recorded" &&
                  (phase === "started" || phase === "completed") &&
                  [
                    "selected_session",
                    "other_session",
                    "all_sessions",
                  ].includes(scope) &&
                  BROWSER_WRAPPER_AGES.includes(age) &&
                  ["after", "before", "same_time", "unavailable"].includes(
                    order,
                  ) &&
                  (order === "unavailable" ||
                    (scope !== "other_session" &&
                      precondition.capture_open_session_matches === true)) &&
                  (phase === "started"
                    ? exit === "none"
                    : exit === "other" ||
                      (typeof exit === "number" &&
                        Number.isInteger(exit) &&
                        exit >= 0 &&
                        exit <= 255))
                ) {
                  precondition.capture_close_receipt_version = 1;
                  precondition.capture_close_receipt_status = "recorded";
                  precondition.capture_close_phase = phase;
                  precondition.capture_close_exit_code = exit;
                  precondition.capture_close_scope = scope;
                  precondition.capture_close_age = age;
                  precondition.capture_close_open_order = order;
                }
              }
            }
          }
        } else
          kind =
            error instanceof TimeoutError
              ? "timeout"
              : error instanceof BrowserPreviewUnavailable
                ? "preview_unavailable"
                : error instanceof Error
                  ? "other_error"
                  : "thrown_value";
      } catch {
        /* Preserve the original failure if optional context is unreadable. */
      }
      let bridgeDiagnostic: BrowserBridgeFailureContext = {};
      try {
        if (stage === "frame_bridge")
          bridgeDiagnostic = browserBridgeFailureContext(
            error instanceof CommandExitError
              ? Object.getOwnPropertyDescriptor(error, "result")?.value
              : returnedBridgeFailure,
          );
      } catch {
        /* Optional transport metadata cannot replace the original rejection. */
      }
      let sdkPhase: ReturnType<typeof statusSdkPhaseContext> = {};
      let sdkProgress: Pick<
        BrowserCaptureFailureContext,
        "capture_sdk_wait_progress_v1" | "capture_sdk_wait_timeout_origin_v1"
      > = {};
      try {
        // Only this exact SDK rejection; an exit already proves a returned handle.
        if (
          stage === "stream_status" &&
          statusRejection &&
          statusRejection.error === error &&
          !(error instanceof CommandExitError)
        ) {
          sdkPhase = statusSdkPhaseContext(statusRejection);
          const { phase, progress, timeoutOrigin } = statusRejection;
          sdkProgress = {
            ...(progress !== undefined && {
              capture_sdk_wait_progress_v1: progress,
            }),
            ...(phase === "wait" &&
              timeoutOrigin !== undefined && {
                capture_sdk_wait_timeout_origin_v1: timeoutOrigin,
              }),
          };
        }
      } catch {
        /* An unreadable phase omits the group and keeps the original rejection. */
      }
      let freshRead: ReturnType<typeof freshReadContext> = {};
      try {
        if (stage === "fresh_read" && freshReadPhase)
          freshRead = freshReadContext(freshReadPhase, error);
      } catch {
        /* An unreadable projection omits the group and keeps the rejection. */
      }
      try {
        onFailure({
          capture_stage: stage,
          capture_error_kind: kind,
          capture_command_exit_code: code,
          ...precondition,
          ...decodeDiagnostic,
          ...bridgeDiagnostic,
          ...sdkPhase,
          ...sdkProgress,
          ...freshRead,
        });
      } catch {
        /* Observers cannot change capture behavior. */
      }
    }
    // The observer above keeps the SDK's exit; callers get the closed state.
    let closed = false;
    try {
      closed =
        stage === "frame_bridge" &&
        error instanceof CommandExitError &&
        bridgeReportedClosed(
          Object.getOwnPropertyDescriptor(error, "result")?.value,
        );
    } catch {
      /* An unreadable SDK error keeps its original rejection. */
    }
    if (closed) throw new BrowserPreviewUnavailable("closed");
    throw error;
  }
}

export type BrowserViewportFailureContext = {
  viewport_diagnostic_version: 1;
  // The viewport daemon command, or the strict fresh capture that follows it.
  viewport_failure_phase: "resize_command" | "capture_frame";
  viewport_error_kind:
    | ReturnType<
        typeof browserRelayRenewFailureContext
      >["relay_renew_error_kind"]
    | "preview_unavailable";
  viewport_command_exit_code: number | "none" | "other";
  // Resize command exit3 only: the helper's own 6s deadline phase, not a cause.
  // Absent means unmeasured (other exit, older writer or unreadable packet).
  viewport_deadline_phase?: (typeof BROWSER_DAEMON_DEADLINE_PHASES)[number];
};

/** Resize only the currently granted session; callers hold the input lease. */
export async function resizeBrowserViewport(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  width: number,
  height: number,
  onFailure?: (context: BrowserViewportFailureContext) => void,
) {
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 240 && value <= 2560,
    )
  )
    throw new Error("Invalid browser viewport");
  let phase: BrowserViewportFailureContext["viewport_failure_phase"] =
    "resize_command";
  let returnedExitCode: number | "other" | undefined;
  let timeoutResult: unknown;
  try {
    const result = await sandbox.commands.run(
      browserDaemonCommand(session.directory, browserSessionName, {
        action: "viewport",
        width,
        height,
        deviceScaleFactor: 1,
      }),
      {
        ...buildSandboxCommandOptions(sandbox),
        timeoutMs: 7_000,
      },
    );
    const exitCode = result.exitCode;
    if (exitCode !== 0) {
      returnedExitCode = exitStatus(exitCode);
      if (exitCode === 3) timeoutResult = result;
      throw new BrowserPreviewUnavailable("disconnected");
    }
    phase = "capture_frame";
    const frame = await captureBrowserFrame(
      sandbox,
      session,
      browserSessionName,
      true,
    );
    // The fresh screenshot uses the new viewport, but the stream can replay
    // metadata from before the resize. Keep input coordinates in the new space.
    return { ...frame, width, height };
  } catch (error) {
    if (onFailure) {
      let kind: BrowserViewportFailureContext["viewport_error_kind"] =
        "unreadable";
      let exitCode: number | "none" | "other" = "other";
      try {
        if (returnedExitCode !== undefined) {
          kind = "command_exit";
          exitCode = returnedExitCode;
        } else {
          const command = browserRelayRenewFailureContext(error);
          kind =
            command.relay_renew_error_kind === "other_error" &&
            error instanceof BrowserPreviewUnavailable
              ? "preview_unavailable"
              : command.relay_renew_error_kind;
          exitCode = command.relay_renew_command_exit_code;
        }
      } catch {
        // An unreadable result or value keeps the phase and original error.
      }
      let deadline: Pick<
        BrowserViewportFailureContext,
        "viewport_deadline_phase"
      > = {};
      try {
        if (phase === "resize_command" && exitCode === 3) {
          // Returned or SDK-owned result data only; never output accessors.
          const result =
            timeoutResult ??
            (error instanceof CommandExitError
              ? Object.getOwnPropertyDescriptor(error, "result")?.value
              : undefined);
          const stdout =
            result && typeof result === "object"
              ? Object.getOwnPropertyDescriptor(result, "stdout")?.value
              : undefined;
          // The daemon emits packets no larger than 544 bytes.
          const value =
            typeof stdout === "string" &&
            stdout.length <= 544 &&
            Buffer.byteLength(stdout) <= 544
              ? daemonDeadlinePhase(JSON.parse(stdout))
              : undefined;
          if (value) deadline = { viewport_deadline_phase: value };
        }
      } catch {
        // A malformed packet omits only this optional field.
      }
      try {
        onFailure({
          viewport_diagnostic_version: 1,
          viewport_failure_phase: phase,
          viewport_error_kind: kind,
          viewport_command_exit_code: exitCode,
          ...deadline,
        });
      } catch {
        // Observers cannot replace the original error or retry the resize.
      }
    }
    throw error;
  }
}

export type BrowserInputFailureContext = {
  input_diagnostic_version: 1;
  input_stage:
    | "read_stream_port"
    | "start_bridge"
    | "send_stdin"
    | "close_stdin"
    | "wait_bridge"
    | "bridge_result";
  input_error_kind: string;
  input_http_status: number | "none" | "other";
  input_command_exit_code: number | "none" | "other";
  input_type_error_signal?: "fetch_failed" | "other_type_error" | "unreadable";
  input_transport_code?: string;
};

/** Preserve the input operation while optionally reporting only its failed await. */
export async function sendBrowserInput(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  events: ReadonlyArray<Record<string, unknown>>,
  streamPort?: number,
  onFailure?: (context: BrowserInputFailureContext) => void,
) {
  let stage: BrowserInputFailureContext["input_stage"] = "read_stream_port";
  let exitCode: BrowserInputFailureContext["input_command_exit_code"] = "none";
  try {
    const port =
      streamPort ??
      (await getPrivateStreamPort(sandbox, session, browserSessionName));
    stage = "start_bridge";
    const handle = await sandbox.commands.run(
      browserBridgeCommand(port, "input"),
      {
        ...buildSandboxCommandOptions(sandbox),
        background: true,
        stdin: true,
        timeoutMs: 8_000,
      },
    );
    // Text, including passwords, remains only in protected process stdin.
    stage = "send_stdin";
    await handle.sendStdin(JSON.stringify(events));
    stage = "close_stdin";
    await handle.closeStdin();
    stage = "wait_bridge";
    const result = await handle.wait();
    stage = "bridge_result";
    const resultCode = result.exitCode;
    if (resultCode !== 0) {
      exitCode =
        Number.isInteger(resultCode) && resultCode >= 0 && resultCode <= 255
          ? resultCode
          : "other";
      throw new BrowserPreviewUnavailable("disconnected");
    }
  } catch (error) {
    if (onFailure) {
      try {
        const cloud = checkpointCloudErrorContext(error);
        const command = browserRelayRenewFailureContext(error);
        onFailure({
          input_diagnostic_version: 1,
          input_stage: stage,
          input_error_kind:
            command.relay_renew_error_kind === "command_exit" ||
            command.relay_renew_error_kind === "timeout"
              ? command.relay_renew_error_kind
              : error instanceof BrowserPreviewUnavailable
                ? "preview_unavailable"
                : cloud.cloud_error_kind,
          input_http_status: cloud.cloud_http_status,
          input_command_exit_code:
            exitCode === "none"
              ? command.relay_renew_command_exit_code
              : exitCode,
          ...(cloud.cloud_type_error_signal === undefined
            ? {}
            : {
                input_type_error_signal: cloud.cloud_type_error_signal,
                input_transport_code: cloud.cloud_transport_code,
              }),
        });
      } catch {
        // Optional observers cannot replace the original error or retry input.
      }
    }
    throw error;
  }
}

type BrowserPauseFailureContext = {
  pause_diagnostic_version: 1;
  pause_error_kind:
    | "gate_busy"
    | "transport"
    | ReturnType<
        typeof browserRelayRenewFailureContext
      >["relay_renew_error_kind"];
  pause_command_exit_code: number | "none" | "other";
  pause_http_status: number | "none" | "other";
};

const returnedPauseFailures = new WeakMap<
  BrowserPreviewUnavailable,
  BrowserPauseFailureContext
>();

function pauseCommandOutcome(result: unknown): BrowserPauseFailureContext {
  const exitCode = exitStatus(ownResultValue(result, "exitCode"));
  const stderr = ownResultValue(result, "stderr");
  // The pause program raises this fixed exception after its local lock deadline.
  const gateBusy =
    exitCode === 1 &&
    typeof stderr === "string" &&
    /(?:^|\n)RuntimeError: Browser command is busy\r?\n?$/.test(
      stderr.slice(-96),
    );
  return {
    pause_diagnostic_version: 1,
    pause_error_kind: gateBusy ? "gate_busy" : "command_exit",
    pause_command_exit_code: exitCode,
    pause_http_status: "none",
  };
}

/** Project the failed pause's bounded SDK or local program outcome. */
export function browserPauseFailureContext(
  error: unknown,
): BrowserPauseFailureContext {
  try {
    if (error instanceof BrowserPreviewUnavailable) {
      const returned = returnedPauseFailures.get(error);
      if (returned) return returned;
    }
    if (error instanceof CommandExitError) {
      return pauseCommandOutcome(
        Object.getOwnPropertyDescriptor(error, "result")?.value,
      );
    }
    const cloud = checkpointCloudErrorContext(error);
    return {
      pause_diagnostic_version: 1,
      pause_error_kind:
        cloud.cloud_type_error_signal === "fetch_failed"
          ? "transport"
          : browserRelayRenewFailureContext(error).relay_renew_error_kind,
      pause_command_exit_code: "none",
      pause_http_status: cloud.cloud_http_status,
    };
  } catch {
    return {
      pause_diagnostic_version: 1,
      pause_error_kind: "unreadable",
      pause_command_exit_code: "other",
      pause_http_status: "none",
    };
  }
}

export async function setAgentBrowserPaused(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  paused: boolean,
) {
  const result = await sandbox.commands.run(
    browserSessionCommand(
      paused ? "pause" : "resume",
      session.directory,
      session.expiresAt,
    ),
    { ...buildSandboxCommandOptions(sandbox), timeoutMs: 10_000 },
  );
  if (result.exitCode !== 0) {
    const error = new BrowserPreviewUnavailable("disconnected");
    if (paused) {
      try {
        returnedPauseFailures.set(error, pauseCommandOutcome(result));
      } catch {
        // Optional attribution preserves the original failure.
      }
    }
    throw error;
  }
}
