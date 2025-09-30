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
        const name: string = part.name || part.filename || "file";
        const localPath = `/home/user/upload/${name}`;
        // Only upload files for the last user message
        if (i === lastUserIdx) {
          sandboxFiles.push({ url: part.url, localPath });
        }
        tags.push(
          `<attachment filename="${name}" local_path="${localPath}" />`,
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
