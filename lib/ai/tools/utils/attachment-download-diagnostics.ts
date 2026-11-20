import type { ReceiverCleanupReason } from "@/lib/centrifugo/receiver-diagnostics";
import type {
  CloudAttachmentDnsDecision,
  CloudAttachmentNetworkRefusal,
} from "@/lib/utils/cloud-attachment-dns";

/** How this transfer's own detecting call chose its client: a positive
 * existence probe or the no-client curl default, made by that call or reused
 * from the adapter's cache. Not executable identity or failure cause. */
export type AttachmentClientSelection =
  | "current_probe_positive"
  | "cached_probe_positive"
  | "current_unverified_default"
  | "cached_unverified_default";
const CLIENT_SELECTIONS = new Set<unknown>([
  "current_probe_positive",
  "cached_probe_positive",
  "current_unverified_default",
  "cached_unverified_default",
] satisfies AttachmentClientSelection[]);

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
  /** Kept only for a curl exit 127 with its "inaccessible or not found"
   * wording; omitted when the caller has no recorded selection. */
  clientSelection?: AttachmentClientSelection;
  /** The selected terminal result's own stdout, supplied only when its
   * Windows Bash curl command carried CURL_PROGRESS_WRITE_OUT. Never kept. */
  curlProgressStdout?: string;
};

const contexts = new WeakMap<object, AttachmentDownloadFailureContext>();

/** One static `--write-out` line from the selected curl command. Values are
 * scoped to curl's report, not to individual attempts. No URL, host or
 * headers; the status and byte count are read here and never kept.
 * No backslash escape, so Git Bash commands stay free of backslashes.
 * time_starttransfer is deliberately absent: curl reports it positive for a
 * stall before any TLS or HTTP bytes, so it cannot prove a response. */
export const CURL_PROGRESS_WRITE_OUT =
  "hackerai_curl_progress_v1 n=%{time_namelookup} c=%{time_connect} a=%{time_appconnect} h=%{http_code} b=%{size_download} r=%{time_redirect}";
// http_code is `%03ld`: 000 (no response) or a status; size_download an integer.
const CURL_PROGRESS_LINE =
  /^hackerai_curl_progress_v1 n=(\d{1,7}\.\d{6}) c=(\d{1,7}\.\d{6}) a=(\d{1,7}\.\d{6}) h=(000|[1-5]\d\d) b=(\d{1,15}) r=(\d{1,7}\.\d{6})(?:\r?\n)?$/;
// A valid line is ~120 characters; anything longer is never scanned.
const CURL_PROGRESS_MAX_LENGTH = 256;

/** The furthest stage curl reported as completed. A zero timer is not proof a
 * stage was never reached, and none of these is the failing phase. Only a real
 * HTTP status proves a response. curl accumulates redirect time across hops,
 * so any redirect stays ambiguous. */
type CurlProgressMilestone =
  | "none_positive"
  | "name_lookup"
  | "connect"
  | "tls_handshake"
  | "response_status_observed"
  | "response_body_observed"
  | "redirected_or_ambiguous";

const positive = (value: string) => /[1-9]/.test(value);

/** Only one exact, internally consistent marker line is read; empty, truncated,
 * repeated or extra output is never partially interpreted. Raw values are never kept. */
function curlProgressContext(stdout: string) {
  const match =
    stdout.length <= CURL_PROGRESS_MAX_LENGTH
      ? CURL_PROGRESS_LINE.exec(stdout)
      : null;
  let milestone: CurlProgressMilestone | null = null;
  // Body bytes without any HTTP status contradict each other: never guessed.
  const observed =
    match?.[0] === stdout && !(match[4] === "000" && positive(match[5]));
  if (observed) {
    const [, lookup, connect, tls, status, bytes, redirect] = match;
    const response = status !== "000";
    milestone = positive(redirect)
      ? "redirected_or_ambiguous"
      : response && positive(bytes)
        ? "response_body_observed"
        : response
          ? "response_status_observed"
          : positive(tls)
            ? "tls_handshake"
            : positive(connect)
              ? "connect"
              : positive(lookup)
                ? "name_lookup"
                : "none_positive";
  }
  return {
    attachment_download_curl_progress_version: 1 as const,
    attachment_download_curl_progress_state: observed
      ? ("observed" as const)
      : stdout === ""
        ? ("absent" as const)
        : ("unrecognized" as const),
    attachment_download_curl_progress_milestone: milestone,
  };
}

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

type Curl35Hint =
  | "schannel_revocation_unavailable"
  | "schannel_illegal_message"
  | "schannel_invalid_token"
  | "schannel_internal_error"
  | "schannel_algorithm_mismatch"
  | "schannel_handshake_receive_failed"
  | "openssl_syscall"
  | "openssl_unexpected_eof"
  | "openssl_wrong_version";

// curl 8.21 schannel.c InitializeSecurityContext failures. Curl_sspi_strerror
// prints `SYMBOL (0x%08lx)`, then optional localized system text.
const SCHANNEL_CONTEXT_FAILED =
  /^curl: \(35\) schannel: (?:initial|next) InitializeSecurityContext failed: ([A-Z_]{1,40} \(0x[0-9a-f]{8}\))(?: - [^\r]{1,255})?$/;
// Only exact symbol and code pairs; other SSPI statuses stay unclassified.
const SCHANNEL_STATUS = new Map<string, Curl35Hint>([
  [
    "CRYPT_E_NO_REVOCATION_CHECK (0x80092012)",
    "schannel_revocation_unavailable",
  ],
  [
    "CRYPT_E_REVOCATION_OFFLINE (0x80092013)",
    "schannel_revocation_unavailable",
  ],
  ["SEC_E_ILLEGAL_MESSAGE (0x80090326)", "schannel_illegal_message"],
  ["SEC_E_INVALID_TOKEN (0x80090308)", "schannel_invalid_token"],
  ["SEC_E_INTERNAL_ERROR (0x80090304)", "schannel_internal_error"],
  ["SEC_E_ALGORITHM_MISMATCH (0x80090331)", "schannel_algorithm_mismatch"],
]);
// curl 8.21 schannel.c receive wording and openssl.c SSL_connect/ossl_strerror
// wording (OpenSSL 3 packed reason codes). The peer host is never kept.
const CURL35_LINES: ReadonlyArray<readonly [RegExp, Curl35Hint]> = [
  [
    /^curl: \(35\) schannel: failed to receive handshake, SSL\/TLS connection failed$/,
    "schannel_handshake_receive_failed",
  ],
  [
    /^curl: \(35\) (?:OpenSSL|LibreSSL|BoringSSL|AWS-LC|quictls) SSL_connect: SSL_ERROR_SYSCALL in connection to \S{1,253}:\d{1,5} ?$/,
    "openssl_syscall",
  ],
  [
    /^curl: \(35\) TLS connect error: (?:OpenSSL|quictls)\/\d[\w.+-]{0,31}: error:0A000126:SSL routines::unexpected eof while reading$/,
    "openssl_unexpected_eof",
  ],
  [
    /^curl: \(35\) TLS connect error: (?:OpenSSL|quictls)\/\d[\w.+-]{0,31}: error:0A00010B:SSL routines::wrong version number$/,
    "openssl_wrong_version",
  ],
];

/** Complete public curl exit35 error-buffer lines only. The hint is observed
 * text, not the proven TLS backend, network cause or final inner retry. SSPI
 * codes, hosts and system text are never kept; conflicting families stay explicit. */
function curl35Context(stderr: string, truncated: boolean) {
  const lines = stderr.split(/\r?\n/);
  // A truncated final segment may continue past the scan budget.
  const complete = truncated ? lines.slice(0, -1) : lines;
  const hints = new Set<Curl35Hint>();
  for (const line of complete) {
    const status = SCHANNEL_CONTEXT_FAILED.exec(line)?.[1];
    const hint =
      status === undefined
        ? CURL35_LINES.find(([pattern]) => pattern.test(line))?.[1]
        : SCHANNEL_STATUS.get(status);
    if (hint) hints.add(hint);
  }
  const hint: Curl35Hint | "multiple" | "unclassified" =
    hints.size > 1
      ? "multiple"
      : (hints.values().next().value ?? "unclassified");
  return {
    attachment_download_curl35_version: 1 as const,
    attachment_download_curl35_line_present: lines.some((line) =>
      /^curl: \(35\) /.test(line),
    ),
    attachment_download_curl35_hint: hint,
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
    ...(input.platform === "windows" &&
    input.shell === "bash" &&
    input.httpClient === "curl" &&
    input.exitCode === 28 &&
    typeof input.curlProgressStdout === "string"
      ? curlProgressContext(input.curlProgressStdout)
      : {}),
    ...(input.httpClient === "curl" && input.exitCode === 1
      ? curl1Context(stderr, input.stderr.length > 8192)
      : {}),
    ...(input.httpClient === "curl" && input.exitCode === 35
      ? curl35Context(stderr, input.stderr.length > 8192)
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
    // The wording gates only whether to keep the caller's closed value.
    ...(input.httpClient === "curl" &&
    input.exitCode === 127 &&
    CLIENT_SELECTIONS.has(input.clientSelection) &&
    /\bcurl:\s*inaccessible or not found\b/i.test(stderr)
      ? {
          attachment_client_selection_version: 1 as const,
          attachment_client_selection_reason:
            input.clientSelection as AttachmentClientSelection,
        }
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
  /** Last shell-context call this download entered; kept only for its phase. */
  shellContextStage?: AttachmentDownloadShellContextStage;
};

/** The awaited call last entered inside the shared shell context, not the
 * native cause, delivery result or recovery. Owned by one download call. */
export type AttachmentDownloadShellContextStage =
  "detect_shell" | "native_path_conversion";
export type AttachmentDownloadShellContextObservation = {
  stage?: AttachmentDownloadShellContextStage;
};
type ShellContextStageContext = {
  attachment_download_shell_context_diagnostic_version: 1;
  attachment_download_shell_context_stage: AttachmentDownloadShellContextStage;
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
/** Closed values from the SDK error context that selected a terminal
 * client_error. `connectionLimitPredicate` is the receiver's existing computed
 * predicate (a "connection limit" message phrase or code 4503), recorded as
 * computed; neither input is a receipt of an actual broker connection quota. */
export type AttachmentCommandReceiverClientError = {
  type: "connect" | "transport" | "other" | "unavailable";
  /** SDK codes 0-99 and the public 4503 code; other numbers are `other`. */
  code: number | "other" | "unavailable";
  temporary: boolean | "unavailable";
  connectionLimitPredicate: boolean;
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
  /** Recorded only with reason `client_error`. */
  clientError?: AttachmentCommandReceiverClientError;
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
type ReceiverClientErrorContext = {
  attachment_command_receiver_client_error_version: 1;
  attachment_command_receiver_client_error_type: AttachmentCommandReceiverClientError["type"];
  attachment_command_receiver_client_error_code: AttachmentCommandReceiverClientError["code"];
  attachment_command_receiver_client_error_temporary: AttachmentCommandReceiverClientError["temporary"];
  attachment_command_receiver_client_error_connection_limit_predicate: boolean;
};
const CLIENT_ERROR_KEYS = [
  "attachment_command_receiver_client_error_version",
  "attachment_command_receiver_client_error_type",
  "attachment_command_receiver_client_error_code",
  "attachment_command_receiver_client_error_temporary",
  "attachment_command_receiver_client_error_connection_limit_predicate",
] as const satisfies readonly (keyof ReceiverClientErrorContext)[];

/** An own data property only: never invokes getters or inherited values. */
function ownDataValue(value: unknown, key: string): unknown {
  try {
    if (
      (typeof value !== "object" || value === null) &&
      typeof value !== "function"
    )
      return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

const isClientErrorCode = (
  code: unknown,
): code is AttachmentCommandReceiverClientError["code"] =>
  code === "other" ||
  code === "unavailable" ||
  code === 4503 ||
  (typeof code === "number" &&
    Number.isInteger(code) &&
    code >= 0 &&
    code <= 99);

/** Snapshot an SDK error context's closed type/code/temporary values. Reads
 * no message or other field, and never throws. */
export function readAttachmentCommandReceiverClientError(
  ctx: unknown,
  connectionLimitPredicate: boolean,
): AttachmentCommandReceiverClientError {
  const type = ownDataValue(ctx, "type");
  const error = ownDataValue(ctx, "error");
  const code = ownDataValue(error, "code");
  const temporary = ownDataValue(error, "temporary");
  return {
    type:
      typeof type !== "string"
        ? "unavailable"
        : type === "connect" || type === "transport"
          ? type
          : "other",
    code:
      typeof code !== "number"
        ? "unavailable"
        : isClientErrorCode(code)
          ? code
          : "other",
    temporary: typeof temporary === "boolean" ? temporary : "unavailable",
    connectionLimitPredicate: connectionLimitPredicate === true,
  };
}

/** Validate the whole group from own data fields; any invalid value omits it. */
function clientErrorContext(
  input: unknown,
): ReceiverClientErrorContext | undefined {
  const type = ownDataValue(input, "type");
  const code = ownDataValue(input, "code");
  const temporary = ownDataValue(input, "temporary");
  const predicate = ownDataValue(input, "connectionLimitPredicate");
  if (
    (type !== "connect" &&
      type !== "transport" &&
      type !== "other" &&
      type !== "unavailable") ||
    !isClientErrorCode(code) ||
    (typeof temporary !== "boolean" && temporary !== "unavailable") ||
    typeof predicate !== "boolean"
  )
    return undefined;
  return {
    attachment_command_receiver_client_error_version: 1,
    attachment_command_receiver_client_error_type: type,
    attachment_command_receiver_client_error_code: code,
    attachment_command_receiver_client_error_temporary: temporary,
    attachment_command_receiver_client_error_connection_limit_predicate:
      predicate,
  };
}
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
  networkReason?: CloudAttachmentNetworkRefusal;
};
type DnsFallbackContext = {
  attachment_download_dns_fallback_version: 1;
  attachment_download_dns_fallback_decision: AttachmentDownloadDnsFallback["decision"];
  attachment_download_dns_fallback_retry_result: AttachmentDownloadDnsFallback["retryResult"];
  attachment_download_dns_fallback_network_version?: 1;
  attachment_download_dns_fallback_network_reason?: CloudAttachmentNetworkRefusal;
};
type AnyFailureContext = Partial<
  ResultContext &
    BoundaryContext &
    ShellContextStageContext &
    RouteContext &
    ReceiverContext &
    ReceiverClientErrorContext &
    SetupContext &
    DnsFallbackContext
>;
export type AttachmentDownloadFailureContext = AnyFailureContext &
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
    const previous: AnyFailureContext = { ...contexts.get(error) };
    // A reused rejection must not keep an earlier receiver's client detail.
    for (const key of CLIENT_ERROR_KEYS) delete previous[key];
    const clientError =
      input.reason === "client_error"
        ? clientErrorContext(input.clientError)
        : undefined;
    contexts.set(error, {
      ...previous,
      attachment_command_receiver_version: 1,
      attachment_command_receiver_reason: input.reason,
      attachment_command_receiver_connected_observed: input.connectedObserved,
      attachment_command_receiver_subscribed_observed: input.subscribedObserved,
      attachment_command_receiver_publication_started: input.publicationStarted,
      attachment_command_receiver_publish_completed: input.publishCompleted,
      attachment_command_receiver_first_message_observed:
        input.firstMessageObserved,
      ...clientError,
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
    const previous: AnyFailureContext = { ...contexts.get(error) };
    // A reused rejection must not keep an earlier call's shell-context stage.
    delete previous.attachment_download_shell_context_diagnostic_version;
    delete previous.attachment_download_shell_context_stage;
    const stage = input.shellContextStage;
    contexts.set(error, {
      ...previous,
      attachment_download_boundary_version: 1,
      attachment_download_phase: input.phase,
      attachment_download_attempt: input.attempt,
      attachment_download_result_state: input.resultState,
      attachment_download_error_kind: kind,
      attachment_download_result_context_present:
        previous.attachment_download_diagnostic_version === 1,
      // Missing or unrecognized stages stay absent rather than guessed.
      ...(input.phase === "shell_context" &&
      (stage === "detect_shell" || stage === "native_path_conversion")
        ? {
            attachment_download_shell_context_diagnostic_version: 1 as const,
            attachment_download_shell_context_stage: stage,
          }
        : {}),
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
      ...(input.decision === "network_not_verified_open" && input.networkReason
        ? {
            attachment_download_dns_fallback_network_version: 1 as const,
            attachment_download_dns_fallback_network_reason:
              input.networkReason,
          }
        : {}),
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
