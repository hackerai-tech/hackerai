import type { ReceiverCleanupReason } from "@/lib/centrifugo/receiver-diagnostics";
import type { CloudAttachmentDnsDecision } from "@/lib/utils/cloud-attachment-dns";

type DownloadInput = {
  platform: "windows" | "posix" | "unknown";
  shell: "bash" | "cmd";
  httpClient: "curl" | "wget" | "powershell";
  exitCode: number;
  stderr: string;
  /** The already-run failure diagnostic command; `truncated` reports original
   * stdout beyond the existing bound. Omitted by callers that never probe. */
  directoryProbe?:
    | { state: "returned"; output: string; truncated: boolean }
    | { state: "unavailable" };
};

const contexts = new WeakMap<object, AttachmentDownloadFailureContext>();

/** Public curl error-buffer wording only, not a proven network phase or the
 * final inner retry. Conflicting observed families stay explicit. */
function curlTimeoutHint(stderr: string) {
  const hints = new Set<
    "resolving" | "connect" | "tls_handshake" | "operation"
  >();
  for (const line of stderr.split(/\r?\n/)) {
    const detail = /^\s*curl:\s*\(28\)\s*(.*)$/i.exec(line)?.[1];
    if (!detail) continue;
    if (/^Resolving timed out\b/i.test(detail)) hints.add("resolving");
    else if (
      /^Connection timed out\b/i.test(detail) ||
      /^Failed to connect\b.*\b(?:timed out|timeout)\b/i.test(detail)
    )
      hints.add("connect");
    else if (
      /^SSL(?:\/TLS)? (?:connection timeout|connect timeout|handshake (?:timed out|timeout))\b/i.test(
        detail,
      )
    )
      hints.add("tls_handshake");
    else if (/^Operation timed out\b/i.test(detail)) hints.add("operation");
  }
  return hints.size > 1
    ? "multiple"
    : (hints.values().next().value ?? "unclassified");
}

/** Complete public curl exit1 wording only; the quoted protocol is never kept.
 * Unsupported and disabled protocols print the same text, so stay merged. */
function curl1Context(stderr: string, truncated: boolean) {
  const lines = stderr.split(/\r?\n/);
  // A truncated final segment may continue past the scan budget.
  const complete = truncated ? lines.slice(0, -1) : lines;
  return {
    attachment_download_curl1_version: 1 as const,
    attachment_download_curl1_line_present: lines.some((line) =>
      /^curl: \(1\) /.test(line),
    ),
    attachment_download_curl1_hint: complete.some((line) =>
      /^curl: \(1\) Protocol "[^"\r\n]{1,64}" not supported or disabled in libcurl$/.test(
        line,
      ),
    )
      ? ("protocol_unsupported_or_disabled" as const)
      : ("unclassified" as const),
  };
}

const SELECTED_CLIENT_ALIASES: Record<
  DownloadInput["httpClient"],
  readonly string[]
> = {
  curl: ["curl", "curl.exe"],
  wget: ["wget", "wget.exe"],
  powershell: ["powershell", "powershell.exe"],
};

// bash/dash/busybox, zsh, Ubuntu command-not-found and cmd.exe wording.
const COMMAND_NOT_FOUND = [
  /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh|dash)(?:: line \d{1,6}|: \d{1,6})?: ([^\s'"]{1,128}): (?:command )?not found$/,
  /^(?:\/(?:usr\/)?bin\/)?zsh(?::\d{1,6})?: command not found: ([^\s'"]{1,128})$/,
  /^Command '([^\s']{1,128})' not found, (?:but can be installed with|did you mean):$/,
  /^'([^'\r\n]{1,260})' is not recognized as an internal or external command,$/,
];
const POSIX_SYNTAX = [
  /^(?:\/(?:usr\/)?bin\/)?(?:bash|sh|dash)(?:: -c)?(?:: line \d{1,6}|: \d{1,6})?: (?:syntax error near unexpected token `[^\r\n]{1,64}'|unexpected EOF while looking for matching `[^\r\n]{1,4}'|Syntax error: (?:Unterminated quoted string|(?:"[^"\r\n]{1,16}"|[a-z]{1,16}(?: [a-z]{1,16}){0,3}) unexpected(?: \(expecting "[^"\r\n]{1,16}"\))?)|syntax error: (?:unterminated quoted string|unexpected (?:end of file|newline|"[^"\r\n]{1,16}")(?: \(expecting "[^"\r\n]{1,16}"\)| from `[^\r\n]{1,16}' command on line \d{1,6})?))$/,
  /^(?:\/(?:usr\/)?bin\/)?zsh(?::\d{1,6})?: (?:parse error near `[^\r\n]{1,64}'|unmatched ["'`])$/,
];
// cmd.exe and Windows PowerShell parser wording.
const WINDOWS_SYNTAX = [
  /^The syntax of the command is incorrect\.$/,
  /^\S{1,64} was unexpected at this time\.$/,
  /^ {0,8}\+ CategoryInfo {1,16}: ParserError: \(:\) \[\], ParentContainsErrorRecordException$/,
];

/** Complete public shell diagnostic lines only. A missing program name is
 * compared with the selected client's aliases and never kept. This is a text
 * observation, not executable identity or cause proof, and never drives recovery. */
function commandHint(
  stderr: string,
  truncated: boolean,
  httpClient: DownloadInput["httpClient"],
) {
  const lines = stderr.split(/\r?\n/);
  // A truncated final segment may continue past the scan budget.
  const complete = truncated ? lines.slice(0, -1) : lines;
  const hints = new Set<
    | "selected_client_not_found"
    | "other_command_not_found"
    | "posix_syntax"
    | "windows_syntax"
  >();
  for (const line of complete) {
    let missing: string | undefined;
    for (const pattern of COMMAND_NOT_FOUND)
      missing ??= pattern.exec(line)?.[1];
    if (missing !== undefined)
      hints.add(
        SELECTED_CLIENT_ALIASES[httpClient]?.includes(missing)
          ? "selected_client_not_found"
          : "other_command_not_found",
      );
    else if (POSIX_SYNTAX.some((pattern) => pattern.test(line)))
      hints.add("posix_syntax");
    else if (WINDOWS_SYNTAX.some((pattern) => pattern.test(line)))
      hints.add("windows_syntax");
  }
  return hints.size > 1
    ? "multiple"
    : (hints.values().next().value ?? "unclassified");
}

/** One complete own flag line. cmd.exe keeps the space echoed before `||`;
 * conflicting or missing lines stay unknown and one flag never implies another. */
function directoryFlag(lines: string[], pattern: RegExp) {
  let value: boolean | null = null;
  for (const line of lines) {
    const match = pattern.exec(line)?.[1];
    if (match === undefined) continue;
    if (value !== null && value !== (match === "true")) return null;
    value = match === "true";
  }
  return value;
}

/** Probe-time observations from the existing diagnostic, not download-time errno,
 * filesystem capacity or recovery. Raw output (paths, df, mounts) is never kept. */
function directoryProbeContext(
  probe: NonNullable<DownloadInput["directoryProbe"]>,
) {
  if (probe.state !== "returned")
    return {
      attachment_download_directory_probe_version: 1 as const,
      attachment_download_directory_probe_state: "unavailable" as const,
      attachment_download_target_dir_exists: null,
      attachment_download_target_dir_writable: null,
      attachment_download_directory_probe_truncated: null,
    };
  const truncated = probe.truncated === true || probe.output.length > 1024;
  const lines = probe.output.slice(0, 1024).split(/\r?\n/);
  // A truncated final segment may continue past the scan budget.
  const complete = truncated ? lines.slice(0, -1) : lines;
  return {
    attachment_download_directory_probe_version: 1 as const,
    attachment_download_directory_probe_state: "returned" as const,
    attachment_download_target_dir_exists: directoryFlag(
      complete,
      /^target_dir_exists=(true|false) *$/,
    ),
    attachment_download_target_dir_writable: directoryFlag(
      complete,
      /^target_dir_writable=(true|false) *$/,
    ),
    attachment_download_directory_probe_truncated: truncated,
  };
}

/** Selected client/shell and reported OS are not executable identity. The shell
 * command can fail in mkdir before its client runs; stderr hints are not cause proof. */
function summarize(input: DownloadInput) {
  const stderr = input.stderr.slice(0, 8192);
  const status =
    input.httpClient === "curl"
      ? /curl:\s*\(22\)\s*The requested URL returned error:\s*([45]\d{2})\b/i.exec(
          stderr,
        )
      : input.httpClient === "wget"
        ? /\bERROR\s+([45]\d{2}):/i.exec(stderr)
        : /The remote server returned an error:\s*\(([45]\d{2})\)/i.exec(
            stderr,
          );
  const signal = !stderr
    ? "empty"
    : status
      ? "http_status"
      : /no space left on device|disk quota exceeded/i.test(stderr)
        ? "disk_full"
        : /permission denied|access is denied|read-only file system/i.test(
              stderr,
            )
          ? "permission"
          : /could not resolve host|unable to resolve host|name or service not known/i.test(
                stderr,
              )
            ? "dns"
            : /certificate|TLS handshake|SSL connect error|schannel:|Could not create SSL\/TLS secure channel/i.test(
                  stderr,
                )
              ? "tls"
              : /syntax error|unexpected token|not recognized as an internal|command not found/i.test(
                    stderr,
                  )
                ? "command_syntax"
                : "other";
  return {
    attachment_download_diagnostic_version: 1 as const,
    attachment_download_platform: input.platform,
    attachment_download_shell: input.shell,
    attachment_download_http_client: input.httpClient,
    attachment_download_exit_code:
      Number.isInteger(input.exitCode) &&
      input.exitCode >= -1 &&
      input.exitCode <= 255
        ? input.exitCode
        : null,
    attachment_download_stderr_signal: signal,
    attachment_download_reported_http_status: status ? Number(status[1]) : null,
    attachment_download_stderr_truncated: input.stderr.length > 8192,
    ...(input.httpClient === "curl" && input.exitCode === 28
      ? {
          attachment_download_timeout_version: 1 as const,
          attachment_download_timeout_hint: curlTimeoutHint(stderr),
        }
      : {}),
    ...(input.httpClient === "curl" && input.exitCode === 1
      ? curl1Context(stderr, input.stderr.length > 8192)
      : {}),
    ...(input.exitCode === 127 || signal === "command_syntax"
      ? {
          attachment_download_command_hint_version: 1 as const,
          attachment_download_command_hint: commandHint(
            stderr,
            input.stderr.length > 8192,
            input.httpClient,
          ),
        }
      : {}),
    ...(input.directoryProbe
      ? directoryProbeContext(input.directoryProbe)
      : {}),
  };
}

export type AttachmentDownloadBoundary = {
  phase:
    | "entry"
    | "validate_url"
    | "shell_context"
    | "http_client"
    | "prepare_command"
    | "curl_capabilities"
    | "powershell_prepare"
    | "download_command"
    | "check_result"
    | "retry_delay"
    | "failure_diagnostics";
  attempt: number;
  resultState: "not_observed" | "success" | "nonzero";
};

type BoundaryContext = {
  attachment_download_boundary_version: 1;
  attachment_download_phase: AttachmentDownloadBoundary["phase"];
  attachment_download_attempt: number;
  attachment_download_result_state: AttachmentDownloadBoundary["resultState"];
  attachment_download_error_kind:
    "type_error" | "error" | "non_error" | "unreadable";
  attachment_download_result_context_present: boolean;
};
type ResultContext = ReturnType<typeof summarize>;
export type AttachmentDownloadRoute =
  "selection" | "native_method" | "generic_command";
type RouteContext = {
  attachment_download_route_version: 1;
  attachment_download_route: AttachmentDownloadRoute;
  attachment_download_boundary_present: boolean;
};
/** Observed by the command receiver that selected this rejection. Publish
 * completion is the existing dispatch result, not execution or sender receipt. */
export type AttachmentCommandReceiver = {
  reason: ReceiverCleanupReason;
  connectedObserved: boolean;
  subscribedObserved: boolean;
  publicationStarted: boolean;
  publishCompleted: boolean;
  firstMessageObserved: boolean;
};
type ReceiverContext = {
  attachment_command_receiver_version: 1;
  attachment_command_receiver_reason: ReceiverCleanupReason;
  attachment_command_receiver_connected_observed: boolean;
  attachment_command_receiver_subscribed_observed: boolean;
  attachment_command_receiver_publication_started: boolean;
  attachment_command_receiver_publish_completed: boolean;
  attachment_command_receiver_first_message_observed: boolean;
};
type SetupContext = {
  attachment_command_setup_version: 1;
  attachment_command_setup_attempt: 1 | 2;
};
/** The cloud DNS-pin recovery this transfer entered. `unavailable` means the
 * helper settled without a decision; `unobserved` is a pinned result that is
 * not a confirmed process exit, so the original failure was kept. */
export type AttachmentDownloadDnsFallback = {
  decision: CloudAttachmentDnsDecision | "unavailable";
  retryResult: "not_attempted" | "nonzero" | "unobserved" | "threw";
};
type DnsFallbackContext = {
  attachment_download_dns_fallback_version: 1;
  attachment_download_dns_fallback_decision: AttachmentDownloadDnsFallback["decision"];
  attachment_download_dns_fallback_retry_result: AttachmentDownloadDnsFallback["retryResult"];
};
export type AttachmentDownloadFailureContext = Partial<
  ResultContext &
    BoundaryContext &
    RouteContext &
    ReceiverContext &
    SetupContext &
    DnsFallbackContext
> &
  (
    | ResultContext
    | BoundaryContext
    | RouteContext
    | ReceiverContext
    | SetupContext
    | DnsFallbackContext
  );

/** Bind the receiver's own finite observations to the exact rejection it
 * selected. Never inspects the rejection or replaces it. */
export function recordAttachmentCommandReceiver(
  error: unknown,
  input: AttachmentCommandReceiver,
): void {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  try {
    contexts.set(error, {
      ...contexts.get(error),
      attachment_command_receiver_version: 1,
      attachment_command_receiver_reason: input.reason,
      attachment_command_receiver_connected_observed: input.connectedObserved,
      attachment_command_receiver_subscribed_observed: input.subscribedObserved,
      attachment_command_receiver_publication_started: input.publicationStarted,
      attachment_command_receiver_publish_completed: input.publishCompleted,
      attachment_command_receiver_first_message_observed:
        input.firstMessageObserved,
    });
  } catch {
    // Optional diagnostics must preserve the original rejection.
  }
}

/** Record the setup attempt whose rejection is rethrown; retried attempts'
 * rejections are never marked. */
export function recordAttachmentCommandSetupAttempt(
  error: unknown,
  attempt: number,
): void {
  if (
    ((typeof error !== "object" || error === null) &&
      typeof error !== "function") ||
    (attempt !== 1 && attempt !== 2)
  )
    return;
  try {
    contexts.set(error, {
      ...contexts.get(error),
      attachment_command_setup_version: 1,
      attachment_command_setup_attempt: attempt,
    });
  } catch {
    // Optional diagnostics must preserve the original rejection.
  }
}

/** Bind failure evidence to the route actually selected by attachment staging,
 * including native rejection without an adapter boundary receipt. */
export function recordAttachmentDownloadRoute(
  error: unknown,
  route: AttachmentDownloadRoute,
): void {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  try {
    const previous = contexts.get(error);
    contexts.set(error, {
      ...previous,
      attachment_download_route_version: 1,
      attachment_download_route: route,
      attachment_download_boundary_present:
        previous?.attachment_download_boundary_version === 1,
    });
  } catch {
    // Preserve the original rejection if optional diagnostics fail.
  }
}

/** Record only this call's finite rejection boundary, preserving any actual
 * nonzero-result evidence. Never inspect private error properties or replace it. */
export function recordAttachmentDownloadBoundary(
  error: unknown,
  input: AttachmentDownloadBoundary,
): void {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  try {
    let kind: BoundaryContext["attachment_download_error_kind"];
    try {
      kind =
        error instanceof TypeError
          ? "type_error"
          : error instanceof Error
            ? "error"
            : "non_error";
    } catch {
      kind = "unreadable";
    }
    const previous = contexts.get(error);
    contexts.set(error, {
      ...previous,
      attachment_download_boundary_version: 1,
      attachment_download_phase: input.phase,
      attachment_download_attempt: input.attempt,
      attachment_download_result_state: input.resultState,
      attachment_download_error_kind: kind,
      attachment_download_result_context_present:
        previous?.attachment_download_diagnostic_version === 1,
    });
  } catch {
    // Optional diagnostics must preserve the original rejection.
  }
}

/** Preserve finite result-bound evidence even when image staging is bypassed. */
export function recordAttachmentDownloadFailure<T extends object>(
  error: T,
  input: DownloadInput,
): T {
  try {
    contexts.set(error, summarize(input));
  } catch {
    // Optional diagnostics must preserve the original rejection.
  }
  return error;
}

/** Add the DNS-pin recovery outcome to the failure it kept. Call after
 * recordAttachmentDownloadFailure, which replaces earlier context. */
export function recordAttachmentDownloadDnsFallback(
  error: object,
  input: AttachmentDownloadDnsFallback,
): void {
  try {
    contexts.set(error, {
      ...contexts.get(error),
      attachment_download_dns_fallback_version: 1,
      attachment_download_dns_fallback_decision: input.decision,
      attachment_download_dns_fallback_retry_result: input.retryResult,
    });
  } catch {
    // Optional diagnostics must preserve the original rejection.
  }
}

export function getAttachmentDownloadFailureContext(
  error: unknown,
): AttachmentDownloadFailureContext | undefined {
  if (
    (typeof error !== "object" || error === null) &&
    typeof error !== "function"
  )
    return;
  const context = contexts.get(error);
  return context && { ...context };
}

export function copyAttachmentDownloadFailureContext<T extends object>(
  from: unknown,
  to: T,
): T {
  const context = getAttachmentDownloadFailureContext(from);
  if (context) contexts.set(to, context);
  return to;
}
