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
        const localPath = `/home/user/upload/${sanitizedName}`;

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

const fetchFileData = async (file: SandboxFile) => {
  if (!file.url || !file.localPath) return null;
  try {
    const res = await fetch(file.url);
    if (!res.ok) return null;
    return { localPath: file.localPath, data: await res.arrayBuffer() };
  } catch {
    return null;
  }
};

/**
 * Uploads files to the sandbox environment in parallel
 * - Fetches file data from URLs
 * - Writes files to sandbox filesystem
 * - Handles errors gracefully without throwing
 */
export const uploadSandboxFiles = async (
  sandboxFiles: SandboxFile[],
  ensureSandbox: () => Promise<any>,
) => {
  try {
    const [sandbox, ...fileDataResults] = await Promise.all([
      ensureSandbox(),
      ...sandboxFiles.map(fetchFileData),
    ]);

    await Promise.all(
      fileDataResults.filter(Boolean).map((fileData) =>
        sandbox.files.write(fileData!.localPath, fileData!.data, {
          user: "user" as const,
        }),
      ),
    );
  } catch (e) {
    console.error("Failed uploading files to sandbox:", e);
  }
};
