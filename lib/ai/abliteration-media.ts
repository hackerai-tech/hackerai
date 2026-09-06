import type { ModelMessage } from "ai";

export const ABLITERATION_MAX_IMAGES_PER_REQUEST = 4;

/** Counts attachments and tool images together at the provider request boundary. */
export function exceedsAbliterationImageLimit(
  messages: ModelMessage[],
): boolean {
  let imageCount = 0;
  const isImage = (part: { type: string; mediaType?: string }) =>
    ["image", "image-data", "image-url"].includes(part.type) ||
    (["file", "file-data", "file-url"].includes(part.type) &&
      part.mediaType?.startsWith("image/"));

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (isImage(part)) imageCount++;
      if (part.type === "tool-result" && part.output.type === "content") {
        for (const output of part.output.value) {
          if (isImage(output)) imageCount++;
        }
      }
      if (imageCount > ABLITERATION_MAX_IMAGES_PER_REQUEST) return true;
    }
  }
  return false;
}
