import "server-only";
import { createHash, randomBytes } from "node:crypto";

import { CommandExitError, Sandbox, TimeoutError } from "@e2b/code-interpreter";
import type { TriggerRunRegion } from "@/lib/api/trigger-region";
import { getE2BClusterRouting } from "@/lib/ai/tools/utils/e2b-cluster";
import { browserSessionCommand } from "@/lib/ai/tools/utils/browser-session-program";
import { buildSandboxCommandOptions } from "@/lib/ai/tools/utils/sandbox-command-options";
import { checkpointCloudErrorContext } from "@/lib/ai/tools/utils/persistence-failure";
import {
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
  BROWSER_CLI_AT_PREPARE_STATUSES,
  BROWSER_WRAPPER_PROCESS_VISIBILITIES,
  BROWSER_OPEN_SOCKET_RETURN_STATUSES,
} from "./daemon-program";
import {
  browserRelayProgram,
  RELAY_START_PROGRAM,
  RELAY_RENEW_FAILURE_CODES,
  RELAY_RENEW_PROGRAM,
  RELAY_STOP_PROGRAM,
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
  if (
    info.state !== "running" ||
    info.metadata?.userID !== session.userId ||
    // Older reusable sandboxes predate cluster metadata. The selected E2B
    // account and endpoint still bind discovery to the intended region.
    (info.metadata?.e2bCluster != null &&
      info.metadata.e2bCluster !== cluster.cluster) ||
    info.metadata?.template !== cluster.template
  ) {
    console.warn("[browser-preview] sandbox identity mismatch");
    throw new BrowserPreviewUnavailable("disconnected");
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

export async function getPrivateStreamPort(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
) {
  const result = await sandbox.commands.run(
    browserDaemonCommand(session.directory, browserSessionName, {
      action: "stream_status",
    }),
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 7_000,
    },
  );
  if (result.exitCode !== 0) throw new BrowserPreviewUnavailable("closed");
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
  const result = await sandbox.commands.run(
    `node -e ${quote(RELAY_STOP_PROGRAM)} ${quote(session.directory)}${grant ? ` ${quote(relayDirectory(session, grant))}` : ""}`,
    {
      ...buildSandboxCommandOptions(sandbox),
      timeoutMs: 7000,
    },
  );
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
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
  capture_close_receipt_version?: 1;
  capture_close_receipt_status?:
    "unavailable" | "not_observed" | "unreadable" | "recorded";
  capture_close_phase?: "started" | "completed";
  capture_close_exit_code?: number | "none" | "other";
  capture_close_scope?: "selected_session" | "other_session" | "all_sessions";
  capture_close_age?: (typeof BROWSER_WRAPPER_AGES)[number];
  capture_close_open_order?: "after" | "before" | "same_time" | "unavailable";
};
/**
 * Capture a validated frame, requesting a separate screenshot when freshness is required.
 * The optional failure observer receives only bounded context; observer failures
 * cannot replace the original rejection or change capture, cleanup, or retry behavior.
 */
export async function captureBrowserFrame(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  requireFresh = false,
  streamPort?: number,
  onFailure?: (context: BrowserCaptureFailureContext) => void,
) {
  let stage: BrowserCaptureFailureContext["capture_stage"] = "stream_status";
  let decodeDiagnostic: FrameDecodeDiagnostic = {};
  let returnedBridgeFailure: unknown;
  try {
    const port =
      streamPort ??
      (await getPrivateStreamPort(sandbox, session, browserSessionName));
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
      throw new BrowserPreviewUnavailable("disconnected");
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
      try {
        stage = "fresh_screenshot";
        const screenshot = await sandbox.commands.run(
          browserDaemonCommand(session.directory, browserSessionName, {
            action: "screenshot",
            path,
            format: "jpeg",
            quality: 65,
          }),
          {
            ...buildSandboxCommandOptions(sandbox),
            timeoutMs: 8_000,
          },
        );
        if (screenshot.exitCode !== 0)
          throw new BrowserPreviewUnavailable("disconnected");
        stage = "fresh_stat";
        const info = await sandbox.files.getInfo(path, {
          user: "root",
          requestTimeoutMs: 4_000,
        });
        if (info.size < 4 || info.size > 675_000)
          throw new BrowserPreviewUnavailable("disconnected");
        stage = "fresh_read";
        const fresh = Buffer.from(
          await sandbox.files.read(path, {
            format: "bytes",
            user: "root",
            requestTimeoutMs: 4_000,
          }),
        );
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
        await sandbox.files
          .remove(path, { user: "root", requestTimeoutMs: 4_000 })
          .catch(() => undefined);
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
        | "capture_wrapper_history_version"
        | "capture_wrapper_history_scope"
        | "capture_wrapper_other_cli_completed"
        | "capture_wrapper_option_prefix_completed"
        | "capture_deadline_diagnostic_version"
        | "capture_deadline_phase"
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
        | "capture_close_receipt_version"
        | "capture_close_receipt_status"
        | "capture_close_phase"
        | "capture_close_exit_code"
        | "capture_close_scope"
        | "capture_close_age"
        | "capture_close_open_order"
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
              const deadline = parsed?.deadline;
              if (
                code === 3 &&
                Array.isArray(deadline) &&
                deadline.length === 2 &&
                deadline[0] === 1 &&
                BROWSER_DAEMON_DEADLINE_PHASES.includes(deadline[1])
              ) {
                precondition.capture_deadline_diagnostic_version = 1;
                precondition.capture_deadline_phase = deadline[1];
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
      try {
        onFailure({
          capture_stage: stage,
          capture_error_kind: kind,
          capture_command_exit_code: code,
          ...precondition,
          ...decodeDiagnostic,
          ...bridgeDiagnostic,
        });
      } catch {
        /* Observers cannot change capture behavior. */
      }
    }
    throw error;
  }
}

/** Resize only the currently granted session; callers hold the input lease. */
export async function resizeBrowserViewport(
  sandbox: Sandbox,
  session: BrowserSessionLocation,
  browserSessionName: string,
  width: number,
  height: number,
) {
  if (
    ![width, height].every(
      (value) => Number.isInteger(value) && value >= 240 && value <= 2560,
    )
  )
    throw new Error("Invalid browser viewport");
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
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
  const frame = await captureBrowserFrame(
    sandbox,
    session,
    browserSessionName,
    true,
  );
  // The fresh screenshot uses the new viewport, but the stream can replay
  // metadata from before the resize. Keep input coordinates in the new space.
  return { ...frame, width, height };
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
  if (result.exitCode !== 0)
    throw new BrowserPreviewUnavailable("disconnected");
}
