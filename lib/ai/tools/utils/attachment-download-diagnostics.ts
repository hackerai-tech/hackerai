type DownloadInput = {
  platform: "windows" | "posix" | "unknown";
  shell: "bash" | "cmd";
  httpClient: "curl" | "wget" | "powershell";
  exitCode: number;
  stderr: string;
};

const contexts = new WeakMap<object, AttachmentDownloadFailureContext>();

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
            : /certificate|TLS handshake|SSL connect error|schannel:/i.test(
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
export type AttachmentDownloadFailureContext = Partial<
  ResultContext & BoundaryContext & RouteContext
> &
  (ResultContext | BoundaryContext | RouteContext);

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
