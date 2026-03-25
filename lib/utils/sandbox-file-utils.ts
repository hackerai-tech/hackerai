import "server-only";

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

  const sanitized =
    name
      .replace(/\s+/g, "_")
      .replace(/[^\w.-]/g, "")
      .replace(/_{2,}/g, "_")
      .replace(/^[._-]+|[._-]+$/g, "") || "file";

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

  // E2B sandbox - combine mkdir + curl into a single command
  const dir = localPath.substring(0, localPath.lastIndexOf("/"));
  const escapedUrl = url.replace(/'/g, "'\\''");
  const escapedLocalPath = localPath.replace(/'/g, "'\\''");

  const mkdirPart = dir ? `mkdir -p '${dir}' &&` : "";
  const result = await sandbox.commands.run(
    `${mkdirPart} curl -fsSL -o '${escapedLocalPath}' '${escapedUrl}'`,
  );

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to download file: ${result.stderr}\n` +
        `  url: ${url.substring(0, 120)}${url.length > 120 ? "..." : ""}\n` +
        `  path: ${localPath}\n` +
        `  exitCode: ${result.exitCode}`,
    );
  }
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
      sandboxFiles.map((f) => ({
        url: f.url.substring(0, 120),
        urlLength: f.url.length,
        localPath: f.localPath,
        protocol: f.url.split("://")[0],
      })),
    );
  }
};
