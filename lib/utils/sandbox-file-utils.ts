import "server-only";

import { createHash } from "node:crypto";
import { UIMessage } from "ai";
import type { SandboxPreference } from "@/types";

export type SandboxFile = {
  url: string;
  localPath: string;
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

const sanitizeFilenameForTerminal = (filename: string): string => {
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
): void => {
  const lastUserIdx = getLastUserMessageIndex(updatedMessages);
  if (lastUserIdx === -1) return;

  updatedMessages.forEach((msg, i) => {
    if (msg.role !== "user" || !msg.parts) return;

    const tags: string[] = [];
    (msg.parts as any[]).forEach((part) => {
      if (part?.type === "file" && part?.fileId && part?.url) {
        const sanitizedName = sanitizeFilenameForTerminal(
          part.name || part.filename || "file",
        );
        const localPath = `${uploadBasePath}/${sanitizedName}`;

        if (i === lastUserIdx) {
          sandboxFiles.push({ url: part.url, localPath });
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

/**
 * Downloads a file from URL to sandbox path
 * Works with both E2B and CentrifugoSandbox
 */
const downloadFileToSandbox = async (
  sandbox: any,
  url: string,
  localPath: string,
): Promise<void> => {
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
  //   7  = couldn't connect
  //   18 = partial transfer
  //   23 = write error (CURLE_WRITE_ERROR) — the prod incident
  //   56 = failure receiving network data
  const TRANSIENT_CURL_EXIT_CODES = new Set([7, 18, 23, 56]);
  const MAX_ATTEMPTS = 3;

  const curlCmd =
    `curl -fsSL --retry 3 --retry-all-errors --retry-delay 1 --create-dirs ` +
    `-o '${escapedLocalPath}' '${escapedUrl}'`;

  let result = await sandbox.commands.run(curlCmd);
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
    result = await sandbox.commands.run(curlCmd);
  }

  // Best-effort diagnostics probe — never let this mask the original error.
  let diagnostics = "";
  try {
    const probe = await sandbox.commands.run(
      `df -h /home/user; ls -la /home/user/upload 2>/dev/null; id`,
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

/**
 * Uploads files to the sandbox environment in parallel
 * - Downloads files directly from S3 URLs using curl in the sandbox
 * - Avoids Convex size limits by not piping data through mutations
 * - Handles errors gracefully without throwing
 */
export const uploadSandboxFiles = async (
  sandboxFiles: SandboxFile[],
  ensureSandbox: () => Promise<any>,
) => {
  if (sandboxFiles.length === 0) return;

  try {
    const sandbox = await ensureSandbox();

    // Download files directly from URLs in the sandbox
    await Promise.all(
      sandboxFiles.map((file) =>
        downloadFileToSandbox(sandbox, file.url, file.localPath),
      ),
    );
  } catch (e) {
    console.error("Failed uploading files to sandbox:", e);
    console.error(
      "Sandbox file details:",
      sandboxFiles.map((f) => {
        let safeUrl: string;
        try {
          const parsed = new URL(f.url);
          safeUrl = `${parsed.origin}${parsed.pathname}`;
        } catch {
          safeUrl = f.url.split("?")[0];
        }
        return {
          url: safeUrl,
          urlLength: f.url.length,
          localPath: f.localPath,
          protocol: f.url.split("://")[0],
        };
      }),
    );
  }
};
