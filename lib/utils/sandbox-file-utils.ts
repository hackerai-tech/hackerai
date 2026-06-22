import "server-only";

import { createHash } from "node:crypto";
import { UIMessage } from "ai";
import type { SandboxPreference } from "@/types";
import { validateDownloadUrl } from "@/lib/ai/tools/utils/path-validation";

export type SandboxFile = {
  localPath: string;
} & (
  | {
      kind: "url";
      url: string;
    }
  | {
      kind: "localPath";
      path: string;
    }
);

export type SandboxFilePathRewrite = {
  from: string;
  to: string;
};

type SandboxUploadResult = {
  failedCount: number;
  pathRewrites: SandboxFilePathRewrite[];
  failureDetails?: SandboxUploadFailureDetail[];
  retriedWithFreshSandbox?: boolean;
};

type SandboxCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  error?: string;
};

type SandboxUploadFailureDetail = {
  kind: SandboxFile["kind"];
  localPath: string;
  error: string;
  transientSandboxCommand: boolean;
  url?: string;
  urlLength?: number;
  protocol?: string;
};

type SandboxRefreshOptions = {
  refresh?: boolean;
  reason?: string;
};

type EnsureSandboxForUpload = (options?: SandboxRefreshOptions) => Promise<any>;

type UploadSandboxFilesOptions = {
  retryWithFreshSandboxOnTransientFailure?: boolean | (() => boolean);
};

const MAX_UPLOAD_FAILURE_CAUSE_LENGTH = 1000;

const logLocalAttachmentDebug = (
  event: string,
  data: Record<string, unknown>,
) => {
  if (process.env.NODE_ENV !== "development") return;
  console.info(`[local-attachments] ${event}`, data);
};

const extractCommandExitCode = (error: unknown): number | null => {
  if (typeof error === "object" && error !== null) {
    const maybeExitCode = (error as { exitCode?: unknown }).exitCode;
    if (typeof maybeExitCode === "number") return maybeExitCode;
  }

  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bexit status (\d+)\b/i);
  if (!match) return null;

  return Number.parseInt(match[1], 10);
};

const commandErrorToResult = (error: unknown): SandboxCommandResult | null => {
  const exitCode = extractCommandExitCode(error);
  if (exitCode === null) return null;

  const commandError =
    typeof error === "object" && error !== null
      ? (error as { stdout?: unknown; stderr?: unknown })
      : {};
  const message = error instanceof Error ? error.message : String(error);

  return {
    stdout: typeof commandError.stdout === "string" ? commandError.stdout : "",
    stderr:
      typeof commandError.stderr === "string" && commandError.stderr
        ? commandError.stderr
        : message,
    exitCode,
    error: message,
  };
};

const TRANSIENT_SANDBOX_COMMAND_ERROR_PATTERN =
  /\b(?:request handshake timed out(?: after \d+ms)?|sandbox command(?: request| channel| transport)? timed out|command (?:channel|transport) timed out|deadline_exceeded|operation timed out:.*\btimeoutMs\b|exceeding ['"]?timeoutMs['"]?|Command timeout after \d+ms)\b/i;
const WRAPPED_FILE_TRANSFER_ERROR_PATTERN =
  /\bfailed to (?:download|copy) file:|curl:\s*\(|\bexitCode:\s*\d+\b/i;
const SANDBOX_COMMAND_MAX_ATTEMPTS = 3;
const SANDBOX_COMMAND_RETRY_BASE_DELAY_MS = 750;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const isTransientSandboxCommandError = (error: unknown): boolean => {
  const message = errorMessage(error);
  if (WRAPPED_FILE_TRANSFER_ERROR_PATTERN.test(message)) return false;
  return TRANSIENT_SANDBOX_COMMAND_ERROR_PATTERN.test(message);
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const runSandboxCommand = async (
  sandbox: any,
  command: string,
): Promise<SandboxCommandResult> => {
  for (let attempt = 1; attempt <= SANDBOX_COMMAND_MAX_ATTEMPTS; attempt++) {
    try {
      const result = await sandbox.commands.run(command);
      return {
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
        exitCode: typeof result?.exitCode === "number" ? result.exitCode : 0,
      };
    } catch (error) {
      const commandResult = commandErrorToResult(error);
      if (commandResult) return commandResult;

      if (
        attempt === SANDBOX_COMMAND_MAX_ATTEMPTS ||
        !isTransientSandboxCommandError(error)
      ) {
        throw error;
      }

      console.warn(
        `[sandbox-command] transient command channel failure on attempt ${attempt}/${SANDBOX_COMMAND_MAX_ATTEMPTS}, retrying: ${errorMessage(error)}`,
      );
      await delay(SANDBOX_COMMAND_RETRY_BASE_DELAY_MS * attempt);
    }
  }

  throw new Error("Sandbox command failed without returning a result");
};

/**
 * E2B uses /home/user/upload; any local connection uses /tmp/hackerai-upload
 * since the host machine may not have /home/user (e.g. macOS in dangerous mode).
 */
export const getUploadBasePath = (
  sandboxPreference: SandboxPreference | undefined,
): string =>
  sandboxPreference === "e2b" || !sandboxPreference
    ? "/home/user/upload"
    : "/tmp/hackerai-upload";

const getLastUserMessageIndex = (messages: UIMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
};

export const sanitizeFilenameForTerminal = (filename: string): string => {
  const basename = filename.split(/[/\\]/g).pop() ?? "file";
  const lastDotIndex = basename.lastIndexOf(".");
  const hasExtension = lastDotIndex > 0;
  const name = hasExtension ? basename.substring(0, lastDotIndex) : basename;
  const ext = hasExtension ? basename.substring(lastDotIndex) : "";

  let sanitized =
    name
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]/g, "")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "") || "file";

  // Truncate long filenames to stay within Windows MAX_PATH (260 chars).
  // Upload base path + separator ≈ 30 chars, so cap the name portion.
  // Append a short hash of the full name to avoid collisions between
  // different long filenames that share the same prefix.
  const MAX_NAME_LEN = 80;
  if (sanitized.length > MAX_NAME_LEN) {
    const hash = createHash("sha256").update(name).digest("hex").slice(0, 8);
    sanitized = sanitized.slice(0, MAX_NAME_LEN - 9) + "_" + hash;
  }

  return sanitized + ext.replace(/[^\w.]/g, "");
};

/**
 * Collects sandbox files from message parts and appends attachment tags
 * - Sanitizes filenames for terminal compatibility
 * - Adds attachment tags to user messages
 * - Only queues files from the last user message for upload
 */
export const collectSandboxFiles = (
  updatedMessages: UIMessage[],
  sandboxFiles: SandboxFile[],
  uploadBasePath: string = getUploadBasePath(undefined),
  options: { allowLocalDesktopFiles?: boolean } = {},
): void => {
  const lastUserIdx = getLastUserMessageIndex(updatedMessages);
  if (lastUserIdx === -1) return;

  updatedMessages.forEach((msg, i) => {
    if (msg.role !== "user" || !msg.parts) return;

    const tags: string[] = [];
    (msg.parts as any[]).forEach((part) => {
      if (part?.type !== "file") return;

      if (part?.storage === "local-desktop") {
        if (!part.localPath) return;
        if (!options.allowLocalDesktopFiles) {
          throw new Error(
            "Desktop-local attachments can only be used with the desktop sandbox.",
          );
        }
        const sanitizedName = sanitizeFilenameForTerminal(
          part.name || part.filename || "file",
        );
        const localPath = `${uploadBasePath}/${sanitizedName}`;
        if (i === lastUserIdx) {
          sandboxFiles.push({
            kind: "localPath",
            path: part.localPath,
            localPath,
          });
        }
        tags.push(
          `<attachment filename="${sanitizedName}" local_path="${localPath}" />`,
        );
        return;
      }

      if (part?.fileId && part?.url) {
        const sanitizedName = sanitizeFilenameForTerminal(
          part.name || part.filename || "file",
        );
        const localPath = `${uploadBasePath}/${sanitizedName}`;

        if (i === lastUserIdx) {
          sandboxFiles.push({ kind: "url", url: part.url, localPath });
        }
        tags.push(
          `<attachment filename="${sanitizedName}" local_path="${localPath}" />`,
        );
      }
    });

    if (tags.length > 0) {
      (msg.parts as any[]).push({ type: "text", text: tags.join("\n") });
    }
  });
};

export const stripLocalDesktopSourcePaths = <T extends { parts?: any[] }>(
  messages: T[],
): T[] =>
  messages.map((message) => {
    if (!message.parts) return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (part?.type !== "file" || part.storage !== "local-desktop") {
          return part;
        }
        const { localPath: _localPath, ...safePart } = part;
        return safePart;
      }),
    };
  });

export const hasLocalDesktopSourcePaths = (
  messages: Array<{ parts?: any[] }>,
): boolean =>
  messages.some((message) =>
    message.parts?.some(
      (part) =>
        part?.type === "file" &&
        part.storage === "local-desktop" &&
        typeof part.localPath === "string" &&
        part.localPath.length > 0,
    ),
  );

const replaceAllPathOccurrences = (
  value: string,
  rewrites: SandboxFilePathRewrite[],
): string =>
  rewrites.reduce(
    (text, rewrite) => text.split(rewrite.from).join(rewrite.to),
    value,
  );

export const rewriteSandboxFilePathsInMessages = <T extends { parts?: any[] }>(
  messages: T[],
  rewrites: SandboxFilePathRewrite[],
): T[] => {
  if (rewrites.length === 0) return messages;

  return messages.map((message) => {
    if (!message.parts) return message;
    return {
      ...message,
      parts: message.parts.map((part) => {
        if (typeof part?.text !== "string") return part;
        return {
          ...part,
          text: replaceAllPathOccurrences(part.text, rewrites),
        };
      }),
    };
  });
};

export const prepareLocalDesktopAttachmentsForTrigger = (
  messages: UIMessage[],
  uploadBasePath: string = getUploadBasePath("desktop"),
): { messages: UIMessage[]; sandboxFiles: SandboxFile[] } => {
  const clonedMessages =
    typeof structuredClone === "function"
      ? structuredClone(messages)
      : JSON.parse(JSON.stringify(messages));
  const preparedMessages = stripLocalDesktopSourcePaths(
    clonedMessages,
  ) as UIMessage[];
  const sandboxFiles: SandboxFile[] = [];
  const lastUserIdx = getLastUserMessageIndex(messages);

  messages.forEach((message, messageIndex) => {
    if (message.role !== "user" || !message.parts) return;

    const tags: string[] = [];
    (message.parts as any[]).forEach((part) => {
      if (
        part?.type !== "file" ||
        part.storage !== "local-desktop" ||
        !part.localPath
      ) {
        return;
      }
      const sanitizedName = sanitizeFilenameForTerminal(
        part.name || part.filename || "file",
      );
      const localPath = `${uploadBasePath}/${sanitizedName}`;
      if (messageIndex === lastUserIdx) {
        sandboxFiles.push({
          kind: "localPath",
          path: part.localPath,
          localPath,
        });
      }
      tags.push(
        `<attachment filename="${sanitizedName}" local_path="${localPath}" />`,
      );
    });

    if (tags.length > 0) {
      (preparedMessages[messageIndex].parts as any[]).push({
        type: "text",
        text: tags.join("\n"),
      });
    }
  });

  logLocalAttachmentDebug("prepared-trigger-local-files", {
    fileCount: sandboxFiles.length,
    scrubbedHasLocalPath:
      JSON.stringify(preparedMessages).includes("localPath"),
  });

  return { messages: preparedMessages, sandboxFiles };
};

/**
 * Downloads a file from URL to sandbox path
 * Works with both E2B and CentrifugoSandbox
 */
const downloadFileToSandbox = async (
  sandbox: any,
  url: string,
  localPath: string,
): Promise<void> => {
  validateDownloadUrl(url);

  // CentrifugoSandbox has downloadFromUrl method
  if (sandbox.files?.downloadFromUrl) {
    return sandbox.files.downloadFromUrl(url, localPath);
  }

  // E2B sandbox - use curl with --create-dirs to avoid a separate mkdir race
  const escapedUrl = url.replace(/'/g, "'\\''");
  const escapedLocalPath = localPath.replace(/'/g, "'\\''");

  // Transient curl exit codes worth retrying at the JS layer as a safety net
  // on top of curl's own --retry. Covers post-resume filesystem hiccups and
  // flaky network recv:
  //   6  = could not resolve host (DNS lag after sandbox resume)
  //   7  = couldn't connect
  //   18 = partial transfer
  //   23 = write error (CURLE_WRITE_ERROR) — the prod incident
  //   56 = failure receiving network data
  const TRANSIENT_CURL_EXIT_CODES = new Set([6, 7, 18, 23, 56]);
  const MAX_ATTEMPTS = 3;

  const curlCmd =
    `curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 --create-dirs ` +
    `-o '${escapedLocalPath}' '${escapedUrl}'`;

  let result = await runSandboxCommand(sandbox, curlCmd);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (result.exitCode === 0) return;
    if (
      attempt === MAX_ATTEMPTS ||
      !TRANSIENT_CURL_EXIT_CODES.has(result.exitCode)
    ) {
      break;
    }
    console.warn(
      `[sandbox-download] curl exit ${result.exitCode} on attempt ${attempt}/${MAX_ATTEMPTS} for ${localPath}, retrying`,
    );
    await new Promise((r) => setTimeout(r, 500 * attempt));
    result = await runSandboxCommand(sandbox, curlCmd);
  }

  // Best-effort diagnostics probe — never let this mask the original error.
  let diagnostics = "";
  try {
    const probe = await runSandboxCommand(
      sandbox,
      `df -h /home/user 2>&1 || true; ls -la /home/user/upload 2>&1 || true; id 2>&1 || true`,
    );
    diagnostics = (probe.stdout || "").slice(0, 1024);
  } catch {
    // ignore probe failures
  }

  // Redact signed query params (e.g. S3 X-Amz-Signature) before logging.
  let safeUrl = url;
  try {
    const parsed = new URL(url);
    safeUrl = `${parsed.origin}${parsed.pathname}`;
  } catch {
    safeUrl = url.split("?")[0];
  }

  throw new Error(
    `Failed to download file: ${result.stderr}\n` +
      `  url: ${safeUrl}\n` +
      `  path: ${localPath}\n` +
      `  exitCode: ${result.exitCode}` +
      (diagnostics ? `\n  diagnostics:\n${diagnostics}` : ""),
  );
};

const copyLocalFileToSandbox = async (
  sandbox: any,
  sourcePath: string,
  localPath: string,
): Promise<void> => {
  if (!sandbox.files?.copyLocal) {
    throw new Error(
      "Desktop-local attachments require a desktop local sandbox.",
    );
  }

  return sandbox.files.copyLocal(sourcePath, localPath);
};

const shellQuote = (value: string): string =>
  `'${value.replace(/'/g, "'\\''")}'`;

const UPLOAD_PATH_FALLBACK_PREFIXES = [
  "/tmp/hackerai-upload/",
  "/home/user/upload/",
];

const UPLOAD_PATH_FALLBACK_ERROR_PATTERN =
  /permission denied|read-only file system|cannot create directory|failed to create directory|exitCode:\s*23|exit status 23|curl:\s*\(23\)|write error|failed writing body|failure writing output|no space left on device/i;

const shouldTryUploadPathFallback = (
  localPath: string,
  error: unknown,
): boolean => {
  if (
    !UPLOAD_PATH_FALLBACK_PREFIXES.some((prefix) =>
      localPath.startsWith(prefix),
    )
  ) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  return UPLOAD_PATH_FALLBACK_ERROR_PATTERN.test(message);
};

const resolveWritableUploadFallbackPath = async (
  sandbox: any,
  originalLocalPath: string,
): Promise<string | null> => {
  const fileName = originalLocalPath.split(/[/\\]/).pop();
  if (!fileName || !sandbox.commands?.run) return null;

  const script = [
    `filename=${shellQuote(fileName)}`,
    `for base in "\${TMPDIR:-/tmp}" /var/tmp "\${HOME:-}" "\${PWD:-.}"; do`,
    `  [ -n "$base" ] || continue`,
    `  dir="$base/hackerai-upload"`,
    `  if mkdir -p "$dir" 2>/dev/null && [ -w "$dir" ]; then`,
    `    cd "$dir" 2>/dev/null && printf '%s/%s' "$(pwd -P)" "$filename"`,
    `    exit 0`,
    `  fi`,
    `done`,
    `exit 1`,
  ].join("\n");

  const result = await sandbox.commands.run(script, {
    displayName: "",
  });
  if (result.exitCode !== 0) return null;
  const fallbackPath = result.stdout.trim();
  return fallbackPath ? fallbackPath : null;
};

const stageSandboxFile = async (
  sandbox: any,
  file: SandboxFile,
): Promise<SandboxFilePathRewrite | null> => {
  try {
    if (file.kind === "url") {
      await downloadFileToSandbox(sandbox, file.url, file.localPath);
    } else {
      await copyLocalFileToSandbox(sandbox, file.path, file.localPath);
    }
    return null;
  } catch (error) {
    if (!shouldTryUploadPathFallback(file.localPath, error)) {
      throw error;
    }

    const fallbackPath = await resolveWritableUploadFallbackPath(
      sandbox,
      file.localPath,
    );
    if (!fallbackPath || fallbackPath === file.localPath) {
      throw error;
    }

    console.warn(
      `[sandbox-upload] ${file.localPath} is not writable, retrying attachment staging at ${fallbackPath}`,
    );

    const fallbackFile = { ...file, localPath: fallbackPath } as SandboxFile;
    try {
      if (fallbackFile.kind === "url") {
        await downloadFileToSandbox(
          sandbox,
          fallbackFile.url,
          fallbackFile.localPath,
        );
      } else {
        await copyLocalFileToSandbox(
          sandbox,
          fallbackFile.path,
          fallbackFile.localPath,
        );
      }
    } catch (fallbackError) {
      const originalMessage =
        error instanceof Error ? error.message : String(error);
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `${originalMessage}\nFallback upload path also failed: ${fallbackMessage}`,
      );
    }

    return { from: file.localPath, to: fallbackPath };
  }
};

const safeUrlForLog = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
};

const describeSandboxFileForLog = (file: SandboxFile) => {
  if (file.kind === "url") {
    return {
      kind: file.kind,
      url: safeUrlForLog(file.url),
      urlLength: file.url.length,
      protocol: file.url.split("://")[0],
      localPath: file.localPath,
    };
  }
  return {
    kind: file.kind,
    sourcePath: "[redacted-local-path]",
    localPath: file.localPath,
  };
};

const summarizeSandboxUploadFailure = (
  file: SandboxFile,
  error: unknown,
): SandboxUploadFailureDetail => {
  const summary: SandboxUploadFailureDetail = {
    kind: file.kind,
    localPath: file.localPath,
    error: redactSandboxUploadError(file, error),
    transientSandboxCommand: isTransientSandboxCommandError(error),
  };

  if (file.kind === "url") {
    summary.url = safeUrlForLog(file.url);
    summary.urlLength = file.url.length;
    summary.protocol = file.url.split("://")[0];
  }

  return summary;
};

const shouldRetryWithFreshSandbox = (
  options: UploadSandboxFilesOptions | undefined,
): boolean => {
  const value = options?.retryWithFreshSandboxOnTransientFailure;
  if (typeof value === "function") return value();
  return value === true;
};

const uploadSandboxFilesOnce = async (
  sandboxFiles: SandboxFile[],
  sandbox: any,
): Promise<SandboxUploadResult> => {
  const results = await Promise.allSettled(
    sandboxFiles.map((file) => stageSandboxFile(sandbox, file)),
  );

  const failedIndices = results
    .map((r, i) => (r.status === "rejected" ? i : -1))
    .filter((i) => i !== -1);

  if (failedIndices.length > 0) {
    console.error(
      `Failed uploading ${failedIndices.length}/${sandboxFiles.length} files to sandbox:`,
    );
    failedIndices.forEach((i) => {
      const file = sandboxFiles[i];
      const result = results[i] as PromiseRejectedResult;
      console.error("  -", {
        ...describeSandboxFileForLog(file),
        error: redactSandboxUploadError(file, result.reason),
      });
    });
  }

  const pathRewrites = results.flatMap((result) =>
    result.status === "fulfilled" && result.value ? [result.value] : [],
  );
  const failureDetails = failedIndices.map((i) =>
    summarizeSandboxUploadFailure(
      sandboxFiles[i],
      (results[i] as PromiseRejectedResult).reason,
    ),
  );

  return {
    failedCount: failedIndices.length,
    pathRewrites,
    ...(failureDetails.length > 0 ? { failureDetails } : {}),
  };
};

const hasTransientSandboxCommandFailure = (
  result: SandboxUploadResult,
): boolean =>
  result.failureDetails?.some((detail) => detail.transientSandboxCommand) ??
  false;

export const getSandboxUploadFailureMetadata = (
  result: SandboxUploadResult,
): Record<string, unknown> | undefined => {
  const failure = result.failureDetails?.[0];
  if (!failure && !result.retriedWithFreshSandbox) return undefined;

  const cause = failure?.error
    ? failure.error.length > MAX_UPLOAD_FAILURE_CAUSE_LENGTH
      ? `${failure.error.slice(0, MAX_UPLOAD_FAILURE_CAUSE_LENGTH)}...`
      : failure.error
    : undefined;

  return {
    ...(failure?.kind ? { upload_failure_kind: failure.kind } : {}),
    ...(cause ? { upload_failure_cause: cause } : {}),
    ...(failure?.transientSandboxCommand !== undefined
      ? {
          upload_failure_transient_sandbox_command:
            failure.transientSandboxCommand,
        }
      : {}),
    ...(failure?.protocol ? { upload_failure_protocol: failure.protocol } : {}),
    ...(typeof failure?.urlLength === "number"
      ? { upload_failure_url_length: failure.urlLength }
      : {}),
    ...(result.retriedWithFreshSandbox !== undefined
      ? {
          upload_retried_with_fresh_sandbox: result.retriedWithFreshSandbox,
        }
      : {}),
  };
};

const redactSandboxUploadError = (
  file: SandboxFile,
  error: unknown,
): string => {
  const message = error instanceof Error ? error.message : String(error);
  if (file.kind !== "localPath") return message;
  return message.split(file.path).join("[redacted-local-path]");
};

/**
 * Uploads files to the sandbox environment in parallel
 * - Downloads files directly from S3 URLs using curl in the sandbox
 * - Avoids Convex size limits by not piping data through mutations
 * - Returns the exact count of failed uploads; sandbox-acquisition failures
 *   count as all-files-failed since nothing can be downloaded
 */
export const uploadSandboxFiles = async (
  sandboxFiles: SandboxFile[],
  ensureSandbox: EnsureSandboxForUpload,
  options?: UploadSandboxFilesOptions,
): Promise<SandboxUploadResult> => {
  if (sandboxFiles.length === 0) return { failedCount: 0, pathRewrites: [] };

  logLocalAttachmentDebug("sandbox-staging-start", {
    totalCount: sandboxFiles.length,
    localPathCount: sandboxFiles.filter((file) => file.kind === "localPath")
      .length,
    urlCount: sandboxFiles.filter((file) => file.kind === "url").length,
  });

  let sandbox: any;
  try {
    sandbox = await ensureSandbox();
  } catch (e) {
    console.error("Failed to acquire sandbox for upload:", e);
    return {
      failedCount: sandboxFiles.length,
      pathRewrites: [],
      failureDetails: sandboxFiles.map((file) =>
        summarizeSandboxUploadFailure(file, e),
      ),
    };
  }

  const firstResult = await uploadSandboxFilesOnce(sandboxFiles, sandbox);

  if (
    firstResult.failedCount > 0 &&
    hasTransientSandboxCommandFailure(firstResult) &&
    shouldRetryWithFreshSandbox(options)
  ) {
    console.warn(
      "[sandbox-upload] transient command channel failure while staging attachments; refreshing sandbox and retrying all attachments",
    );
    try {
      const refreshedSandbox = await ensureSandbox({
        refresh: true,
        reason: "attachment_staging_transient_command_failure",
      });
      const retryResult = await uploadSandboxFilesOnce(
        sandboxFiles,
        refreshedSandbox,
      );
      return { ...retryResult, retriedWithFreshSandbox: true };
    } catch (error) {
      console.error("Failed to refresh sandbox for upload retry:", error);
      return {
        failedCount: sandboxFiles.length,
        pathRewrites: [],
        failureDetails: sandboxFiles.map((file) =>
          summarizeSandboxUploadFailure(file, error),
        ),
        retriedWithFreshSandbox: true,
      };
    }
  }

  return firstResult;
};
