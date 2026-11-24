// Relative so Convex functions can import this module too.
import type { FileMessagePart } from "../../types/file";

/** Queued follow-ups per chat, matching the browser queue's limit. */
export const QUEUED_MESSAGE_MAX_COUNT = 10;
// Well inside Convex's 1 MiB document limit even for multi-byte text.
export const QUEUED_MESSAGE_MAX_TEXT_LENGTH = 200_000;

export const isValidQueuedMessageId = (id: string) =>
  /^[A-Za-z0-9_-]{1,64}$/.test(id);

const STORED_FILE_FIELDS = [
  "mediaType",
  "fileId",
  "name",
  "size",
  "storage",
  "generatedSource",
  "localAttachmentId",
] as const;

/**
 * File parts as stored with a queued message. URLs expire and local paths
 * must never be persisted, so only the identifying fields are kept.
 */
export function sanitizeQueuedFiles(files: unknown): FileMessagePart[] {
  if (!Array.isArray(files)) return [];
  return files.flatMap((file) => {
    if (!file || typeof file !== "object") return [];
    const source = file as Record<string, unknown>;
    if (source.type !== "file") return [];
    const stored: Record<string, unknown> = { type: "file" };
    for (const field of STORED_FILE_FIELDS)
      if (source[field] !== undefined) stored[field] = source[field];
    return [stored as unknown as FileMessagePart];
  });
}
