import "server-only";

import { UIMessage } from "ai";

export type SandboxFile = {
  url: string;
  localPath: string;
};

const getLastUserMessageIndex = (messages: UIMessage[]): number => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
};

/**
 * Sanitizes a filename to be terminal-friendly by removing/replacing problematic characters
 * - Replaces spaces with underscores
 * - Removes special characters that need escaping
 * - Preserves file extension
 * - Ensures the name is valid and readable
 */
const sanitizeFilenameForTerminal = (filename: string): string => {
  // Remove path separators first
  const basename = filename.split(/[/\\]/g).pop() ?? "file";

  // Split into name and extension
  const lastDotIndex = basename.lastIndexOf(".");
  const hasExtension = lastDotIndex > 0;
  const name = hasExtension ? basename.substring(0, lastDotIndex) : basename;
  const ext = hasExtension ? basename.substring(lastDotIndex) : "";

  // Replace spaces and special characters
  let sanitized = name
    .replace(/\s+/g, "_") // Replace spaces with underscores
    .replace(/[^\w.-]/g, "") // Remove special characters except word chars, dots, and hyphens
    .replace(/_{2,}/g, "_") // Replace multiple underscores with single
    .replace(/^[._-]+/, "") // Remove leading dots, underscores, or hyphens
    .replace(/[._-]+$/, ""); // Remove trailing dots, underscores, or hyphens

  // Fallback if name becomes empty
  if (!sanitized) {
    sanitized = "file";
  }

  // Sanitize extension (remove special chars except the leading dot)
  const sanitizedExt = ext.replace(/[^\w.]/g, "");

  return sanitized + sanitizedExt;
};

/**
 * Collects sandbox files from message parts and appends attachment tags in agent mode
 */
export const collectSandboxFiles = (
  updatedMessages: UIMessage[],
  sandboxFiles: SandboxFile[],
): void => {
  const lastUserIdx = getLastUserMessageIndex(updatedMessages);
  if (lastUserIdx === -1) return;

  for (let i = 0; i < updatedMessages.length; i++) {
    const msg = updatedMessages[i];
    if (msg.role !== "user" || !msg.parts) continue;

    const tags: string[] = [];

    for (const part of msg.parts as any[]) {
      if (part?.type === "file" && part?.fileId && part?.url) {
        const rawName: string = part.name || part.filename || "file";
        const sanitizedName = sanitizeFilenameForTerminal(rawName);
        const localPath = `/home/user/upload/${sanitizedName}`;
        // Only upload files for the last user message
        if (i === lastUserIdx) {
          sandboxFiles.push({ url: part.url, localPath });
        }
        tags.push(
          `<attachment filename="${sanitizedName}" local_path="${localPath}" />`,
        );
      }
    }

    if (tags.length > 0) {
      (msg.parts as any[]).push({ type: "text", text: tags.join("\n") });
    }
  }
};

export const uploadSandboxFiles = async (
  sandboxFiles: SandboxFile[],
  ensureSandbox: () => Promise<any>,
) => {
  try {
    const sandbox = await ensureSandbox();
    for (const file of sandboxFiles) {
      if (!file.url || !file.localPath) continue;
      const res = await fetch(file.url);
      if (!res.ok) continue;
      const ab = await res.arrayBuffer();
      await sandbox.files.write(file.localPath, ab);
    }
  } catch (e) {
    console.error("Failed uploading files to sandbox:", e);
  }
};
