import type { ModelMessage } from "ai";

export interface ProviderRequestMediaCounts {
  image_parts: number;
  user_image_parts: number;
  assistant_image_parts: number;
  tool_image_parts: number;
  other_image_parts: number;
  url_images: number;
  inline_images: number;
  provider_id_images: number;
  unknown_images: number;
  pdf_file_parts: number;
  other_file_parts: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const imageRepresentation = (
  value: unknown,
): "url_images" | "inline_images" | "unknown_images" => {
  if (value instanceof URL) {
    return value.protocol === "data:"
      ? "inline_images"
      : /^https?:$/.test(value.protocol)
        ? "url_images"
        : "unknown_images";
  }
  if (typeof value === "string" && value.length > 0) {
    const prefix = value.slice(0, 32);
    if (/^https?:\/\//i.test(prefix)) return "url_images";
    // SDK string data is base64 or a data URL. Do not decode or copy it.
    return /^data:/i.test(prefix) || !/^[a-z][a-z\d+.-]*:/i.test(prefix)
      ? "inline_images"
      : "unknown_images";
  }
  return value instanceof Uint8Array || value instanceof ArrayBuffer
    ? "inline_images"
    : "unknown_images";
};

/** Counts model-input occurrences, not unique images or downloaded bytes. */
export const getProviderRequestMediaCounts = (
  messages: readonly ModelMessage[],
): ProviderRequestMediaCounts => {
  const counts: ProviderRequestMediaCounts = {
    image_parts: 0,
    user_image_parts: 0,
    assistant_image_parts: 0,
    tool_image_parts: 0,
    other_image_parts: 0,
    url_images: 0,
    inline_images: 0,
    provider_id_images: 0,
    unknown_images: 0,
    pdf_file_parts: 0,
    other_file_parts: 0,
  };
  const addImage = (role: string, value: unknown, providerId = false) => {
    counts.image_parts++;
    const roleKey =
      role === "user"
        ? "user_image_parts"
        : role === "assistant"
          ? "assistant_image_parts"
          : role === "tool"
            ? "tool_image_parts"
            : "other_image_parts";
    counts[roleKey]++;
    counts[providerId ? "provider_id_images" : imageRepresentation(value)]++;
  };
  const addFile = (role: string, mediaType: unknown, data: unknown) => {
    if (typeof mediaType === "string" && /^image\//i.test(mediaType)) {
      addImage(role, data);
    } else if (mediaType === "application/pdf") {
      counts.pdf_file_parts++;
    } else {
      counts.other_file_parts++;
    }
  };

  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part.type === "image") {
        addImage(message.role, part.image);
      } else if (part.type === "file") {
        addFile(message.role, part.mediaType, part.data);
      } else if (
        part.type === "tool-result" &&
        part.output.type === "content"
      ) {
        // Only SDK media blocks are model input. Never walk arbitrary tool JSON.
        for (const block of part.output.value) {
          if (!isRecord(block)) continue;
          switch (block.type) {
            case "image-data":
              addImage(message.role, block.data);
              break;
            case "image-url":
              addImage(message.role, block.url);
              break;
            case "image-file-id":
              addImage(message.role, undefined, true);
              break;
            case "media":
            case "file-data":
              addFile(message.role, block.mediaType, block.data);
              break;
            case "file-url":
              addFile(message.role, block.mediaType, block.url);
              break;
            case "file-id":
              counts.other_file_parts++;
              break;
          }
        }
      }
    }
  }
  return counts;
};
