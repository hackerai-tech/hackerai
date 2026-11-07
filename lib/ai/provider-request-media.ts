import type { ModelMessage, UIMessage } from "ai";

export interface ProviderRequestMediaCounts {
  image_parts: number;
  user_image_parts: number;
  assistant_image_parts: number;
  tool_image_parts: number;
  other_image_parts: number;
  url_images: number;
  // Optional for older web/worker diagnostic records during deployment skew.
  url_expiry_hint_expired_images?: number;
  url_expiry_hint_near_images?: number;
  url_expiry_hint_later_images?: number;
  url_expiry_hint_unknown_images?: number;
  user_url_images_with_file_reference_match?: number;
  user_url_images_without_file_reference_match?: number;
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

// These untrusted SigV4 hints describe the input snapshot, not URL accessibility
// or signature/credential validity. Never fetch an image or retain URL material.
const imageUrlExpiryHint = (
  value: unknown,
  nowMs: number,
): "expired" | "near" | "later" | "unknown" => {
  const raw = value instanceof URL ? value.href : value;
  if (typeof raw !== "string" || raw.length > 8192 || !Number.isFinite(nowMs)) {
    return "unknown";
  }
  try {
    const params = new URL(raw).searchParams;
    const algorithms = params.getAll("X-Amz-Algorithm");
    const dates = params.getAll("X-Amz-Date");
    const expiries = params.getAll("X-Amz-Expires");
    if (
      algorithms.length !== 1 ||
      algorithms[0] !== "AWS4-HMAC-SHA256" ||
      dates.length !== 1 ||
      expiries.length !== 1 ||
      !/^\d{8}T\d{6}Z$/.test(dates[0]) ||
      !/^\d{1,6}$/.test(expiries[0])
    )
      return "unknown";
    const date = dates[0];
    const signedAt = Date.parse(
      `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${date.slice(9, 11)}:${date.slice(11, 13)}:${date.slice(13, 15)}Z`,
    );
    const seconds = Number(expiries[0]);
    if (
      !Number.isFinite(signedAt) ||
      signedAt > nowMs ||
      new Date(signedAt)
        .toISOString()
        .replace(/[-:]/g, "")
        .replace(".000", "") !== date ||
      seconds < 1 ||
      seconds > 604800
    )
      return "unknown";
    const remaining = signedAt + seconds * 1000 - nowMs;
    return remaining <= 0 ? "expired" : remaining <= 300_000 ? "near" : "later";
  } catch {
    return "unknown";
  }
};

/**
 * Count model-input occurrences, not unique images or downloaded bytes.
 * Optional current UI references establish exact URL correlation only, never
 * ownership, accessibility or the source of an unmatched historical image.
 */
export const getProviderRequestMediaCounts = (
  messages: readonly ModelMessage[],
  nowMs = Date.now(),
  sourceMessages?: readonly UIMessage[],
): ProviderRequestMediaCounts => {
  let fileReferenceUrls: Set<string> | undefined;
  try {
    const references = new Set<string>();
    for (const message of sourceMessages ?? []) {
      if (message.role !== "user") continue;
      for (const part of message.parts) {
        const fileId = isRecord(part)
          ? Object.getOwnPropertyDescriptor(part, "fileId")?.value
          : undefined;
        if (
          isRecord(part) &&
          part.type === "file" &&
          typeof part.mediaType === "string" &&
          /^image\//i.test(part.mediaType) &&
          typeof fileId === "string" &&
          fileId.length > 0 &&
          typeof part.url === "string"
        ) {
          references.add(part.url);
        }
      }
    }
    if (sourceMessages !== undefined) fileReferenceUrls = references;
  } catch {
    /* Unavailable optional context must not interrupt the provider request. */
  }
  const counts: ProviderRequestMediaCounts = {
    image_parts: 0,
    user_image_parts: 0,
    assistant_image_parts: 0,
    tool_image_parts: 0,
    other_image_parts: 0,
    url_images: 0,
    url_expiry_hint_expired_images: 0,
    url_expiry_hint_near_images: 0,
    url_expiry_hint_later_images: 0,
    url_expiry_hint_unknown_images: 0,
    inline_images: 0,
    provider_id_images: 0,
    unknown_images: 0,
    pdf_file_parts: 0,
    other_file_parts: 0,
    ...(fileReferenceUrls !== undefined && {
      user_url_images_with_file_reference_match: 0,
      user_url_images_without_file_reference_match: 0,
    }),
  } satisfies ProviderRequestMediaCounts;
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
    const representation = providerId
      ? "provider_id_images"
      : imageRepresentation(value);
    counts[representation]++;
    if (representation === "url_images") {
      const expiryField =
        `url_expiry_hint_${imageUrlExpiryHint(value, nowMs)}_images` as const;
      counts[expiryField] = (counts[expiryField] ?? 0) + 1;
      if (role === "user" && fileReferenceUrls !== undefined) {
        const field = fileReferenceUrls.has(
          value instanceof URL ? value.href : (value as string),
        )
          ? "user_url_images_with_file_reference_match"
          : "user_url_images_without_file_reference_match";
        counts[field] = (counts[field] ?? 0) + 1;
      }
    }
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
