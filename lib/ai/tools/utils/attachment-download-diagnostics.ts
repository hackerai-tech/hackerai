type DownloadInput = {
  platform: "windows" | "posix" | "unknown";
  shell: "bash" | "cmd";
  httpClient: "curl" | "wget" | "powershell";
  exitCode: number;
  stderr: string;
};

const contexts = new WeakMap<object, ReturnType<typeof summarize>>();

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

export type AttachmentDownloadFailureContext = ReturnType<typeof summarize>;

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
