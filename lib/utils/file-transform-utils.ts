import "server-only";

import { api } from "@/convex/_generated/api";
import { getConvexClient } from "@/lib/db/convex-client";
import { UIMessage } from "ai";
import type { ChatMode, FileContent } from "@/types";
import { Id } from "@/convex/_generated/dataModel";
import {
  isSandboxOnlyAgentUpload,
  isSupportedImageMediaType,
  MAX_PROVIDER_IMAGE_SIZE_BYTES as MAX_IMAGE_SIZE,
} from "./upload-policy";
import type { SandboxFile } from "./sandbox-file-utils";
import { collectSandboxFiles } from "./sandbox-file-utils";
import { extractAllFileIdsFromMessages, isFilePart } from "./file-token-utils";
import { getMaxFileTokens } from "../token-utils";
import type { SubscriptionTier } from "@/types";
import { logger } from "@/lib/logger";
import { validateDownloadUrl } from "@/lib/ai/tools/utils/path-validation";
import { stringifyRedactedError } from "@/lib/utils/error-redaction";
import {
  normalizeImageMediaType,
  validateImageBytes,
  type ImageValidationResult,
} from "@/lib/utils/image-validation";

const serviceKey = process.env.CONVEX_SERVICE_ROLE_KEY!;
const MAX_PROVIDER_IMAGE_DOWNLOAD_SIZE = 30 * 1024 * 1024;
const MAX_CONVEX_FILE_URL_BATCH_SIZE = 50;

type FileToProcess = {
  fileId?: string;
  url?: string;
  mediaType?: string;
  sizeBytes?: number;
  positions: Array<{ messageIndex: number; partIndex: number }>;
};

type ResolvedFileUrlInfo = {
  url: string;
  sizeBytes?: number;
  mediaType?: string;
  name?: string;
};

type SizeProbeResult = {
  bytes: number;
  source: "file_record" | "content_length" | "content_range" | "download_probe";
};

const providerUnsafeImageParts = new WeakSet<object>();

const redactUrlForLog = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return url.split("?")[0];
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getFiniteSizeBytes = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const validateResolvedFileUrlInfo = (
  info: ResolvedFileUrlInfo | string | null | undefined,
  fileId: string,
): ResolvedFileUrlInfo | null => {
  const url =
    typeof info === "string"
      ? info
      : isRecord(info) && typeof info.url === "string"
        ? info.url
        : null;
  if (!url) return null;

  try {
    validateDownloadUrl(url);
    if (typeof info === "string") {
      return { url };
    }
    if (!isRecord(info)) {
      return { url };
    }

    return {
      url,
      sizeBytes: getFiniteSizeBytes(info.sizeBytes),
      mediaType:
        typeof info.mediaType === "string" ? info.mediaType : undefined,
      name: typeof info.name === "string" ? info.name : undefined,
    };
  } catch (error) {
    logger.warn("resolved_file_url_rejected", {
      event: "resolved_file_url_rejected",
      service: "chat-handler",
      file_id: fileId,
      url: redactUrlForLog(url),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
};

const containsPdfAttachments = (messages: UIMessage[]): boolean =>
  messages.some((msg: any) =>
    (msg.parts || []).some(
      (part: any) => isFilePart(part) && part.mediaType === "application/pdf",
    ),
  );

const isMediaFile = (mediaType?: string) =>
  mediaType &&
  (isSupportedImageMediaType(mediaType) || mediaType === "application/pdf");

const isImageMediaType = (mediaType?: string) =>
  typeof mediaType === "string" && mediaType.toLowerCase().startsWith("image/");

const convertUrlToBase64DataUrl = async (
  url: string,
  mediaType: string,
): Promise<string> => {
  if (!url) return url;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      console.error(`Failed to fetch file (${response.status}): ${url}`);
      return url;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    return `data:${mediaType};base64,${buffer.toString("base64")}`;
  } catch (error) {
    console.error("Failed to convert file to base64:", {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return url;
  } finally {
    clearTimeout(timeoutId);
  }
};

const parseContentLength = (value: string | null): number | null => {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

const parseContentRangeTotal = (value: string | null): number | null => {
  if (!value) return null;
  const match = value.match(/\/(\d+)$/);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const probeContentLength = async (
  url: string,
): Promise<SizeProbeResult | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const response = await fetch(url, {
      method: "HEAD",
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const parsed = parseContentLength(response.headers.get("content-length"));
    return parsed == null ? null : { bytes: parsed, source: "content_length" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const probeDownloadSize = async (
  url: string,
  limitBytes: number,
): Promise<SizeProbeResult | null> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, {
      headers: { Range: `bytes=0-${limitBytes}` },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const rangeTotal = parseContentRangeTotal(
      response.headers.get("content-range"),
    );
    if (rangeTotal != null) {
      return { bytes: rangeTotal, source: "content_range" };
    }

    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength != null && response.status !== 206) {
      return { bytes: contentLength, source: "content_length" };
    }

    if (!response.body) {
      return contentLength == null
        ? null
        : { bytes: contentLength, source: "download_probe" };
    }

    const reader = response.body.getReader();
    let bytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limitBytes) {
        controller.abort();
        return { bytes, source: "download_probe" };
      }
    }

    return { bytes, source: "download_probe" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
};

const probeImageSize = async (
  url: string,
  limitBytes: number,
): Promise<SizeProbeResult | null> =>
  (await probeContentLength(url)) ?? (await probeDownloadSize(url, limitBytes));

const readResponseBytesWithLimit = async (
  response: Response,
  limitBytes: number,
): Promise<Uint8Array | null> => {
  if (!response.body) {
    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength == null || contentLength > limitBytes) return null;
    if (typeof response.arrayBuffer !== "function") return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > limitBytes ? null : bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    totalBytes += value.byteLength;
    if (totalBytes > limitBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return buffer;
};

const validateImageUrl = async (
  url: string,
  mediaType: string | undefined,
  limitBytes: number,
): Promise<ImageValidationResult> => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      return {
        valid: false,
        reason: `image_validation_download_failed_${response.status}`,
      };
    }

    const contentLength = parseContentLength(
      response.headers.get("content-length"),
    );
    if (contentLength != null && contentLength > limitBytes) {
      return { valid: false, reason: "image_validation_size_exceeded" };
    }

    const bytes = await readResponseBytesWithLimit(response, limitBytes);
    if (!bytes) {
      return { valid: false, reason: "image_validation_size_exceeded" };
    }

    const validation = validateImageBytes(bytes, mediaType);
    if (
      !validation.valid &&
      validation.reason === "declared_media_type_mismatch" &&
      validation.detectedMediaType &&
      isSupportedImageMediaType(validation.detectedMediaType)
    ) {
      return { valid: true, mediaType: validation.detectedMediaType };
    }

    return validation;
  } catch (error) {
    return {
      valid: false,
      reason:
        error instanceof DOMException && error.name === "AbortError"
          ? "image_validation_download_timeout"
          : "image_validation_download_failed",
    };
  } finally {
    clearTimeout(timeoutId);
  }
};

const imageOmittedText = (
  name: unknown,
  sizeBytes: number,
  limitBytes: number,
) =>
  `[Image "${typeof name === "string" && name.length > 0 ? name : "unnamed"}" omitted: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB exceeds the ${limitBytes / (1024 * 1024)} MB per-image limit]`;

const untrustedImageUrlOmittedText = (name: unknown) =>
  `[Image "${typeof name === "string" && name.length > 0 ? name : "unnamed"}" omitted: URL-backed image attachments must be reattached before they can be sent to the model]`;

const unverifiedImageOmittedText = (name: unknown) =>
  `[Image "${typeof name === "string" && name.length > 0 ? name : "unnamed"}" omitted: could not verify the image size before sending it to the model. Please reattach a smaller image or use Agent mode for large images.]`;

const invalidImageOmittedText = (name: unknown) =>
  `[Image "${typeof name === "string" && name.length > 0 ? name : "unnamed"}" omitted: could not verify valid image bytes before sending it to the model. Please reattach or regenerate the image.]`;

/**
 * Replace non-stored image file parts whose declared size exceeds Anthropic's
 * 5 MiB per-image limit with a short text note. Stored `fileId` images are
 * checked against their resolved storage URL below, so stale message metadata
 * cannot omit an otherwise valid image.
 */
const replaceOversizedImageParts = (messages: UIMessage[]) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = (msg.parts as any[]).map((part) => {
      if (
        !isFilePart(part) ||
        !isSupportedImageMediaType(part.mediaType ?? "") ||
        typeof (part as any).fileId === "string" ||
        typeof (part as any).size !== "number" ||
        (part as any).size <= MAX_IMAGE_SIZE
      ) {
        return part;
      }
      return {
        type: "text",
        text: imageOmittedText(
          (part as any).name,
          (part as any).size,
          MAX_IMAGE_SIZE,
        ),
      };
    });
  });
};

/**
 * Legacy URL-only image parts are provider-visible but cannot be owner-checked
 * or safely size-probed server-side. Replace them before OpenRouter can
 * download an oversized image and fail the request with a provider 413.
 */
const replaceUntrustedImageUrlParts = (messages: UIMessage[]) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = (msg.parts as any[]).map((part) => {
      if (
        !isFilePart(part) ||
        !isImageMediaType(part.mediaType) ||
        typeof (part as any).fileId === "string" ||
        typeof (part as any).url !== "string"
      ) {
        return part;
      }

      logger.warn("untrusted_image_url_attachment_omitted", {
        event: "untrusted_image_url_attachment_omitted",
        service: "chat-handler",
        media_type: part.mediaType,
        mode: "provider-prep",
      });

      return {
        type: "text",
        text: untrustedImageUrlOmittedText((part as any).name),
      };
    });
  });
};

const collectFilesToProcess = (
  messages: UIMessage[],
  mode: ChatMode,
): {
  hasMedia: boolean;
  files: Map<string, FileToProcess>;
} => {
  let hasMedia = false;
  const files = new Map<string, FileToProcess>();

  messages.forEach((msg, messageIndex) => {
    if (!msg.parts) return;

    (msg.parts as any[]).forEach((part, partIndex) => {
      if (!isFilePart(part)) return;

      const fileId = typeof part.fileId === "string" ? part.fileId : undefined;
      if (fileId) {
        // File IDs are storage references, not proof that a request-supplied URL
        // is safe. Clear any client URL so every server-side fetch/download uses
        // an owner-checked URL resolved from storage below.
        delete (part as any).url;
      }

      if (isMediaFile(part.mediaType)) hasMedia = true;

      const shouldProcess =
        mode === "agent" ||
        part.mediaType === "application/pdf" ||
        isMediaFile(part.mediaType);

      if (shouldProcess) {
        if (!fileId) return;

        const key = `file:${fileId}`;

        if (!files.has(key)) {
          files.set(key, {
            fileId,
            mediaType: part.mediaType,
            positions: [],
          });
        }
        files.get(key)!.positions.push({ messageIndex, partIndex });
      }
    });
  });

  return { hasMedia, files };
};

const fetchFileUrls = async (
  fileIds: string[],
  userId: string | undefined,
): Promise<(ResolvedFileUrlInfo | string | null)[]> => {
  if (!fileIds.length) return [];
  if (!userId) {
    logger.warn("file_url_fetch_skipped_missing_user_id", {
      event: "file_url_fetch_skipped_missing_user_id",
      service: "chat-handler",
      file_count: fileIds.length,
    });
    return [];
  }

  try {
    const chunks: string[][] = [];
    for (let i = 0; i < fileIds.length; i += MAX_CONVEX_FILE_URL_BATCH_SIZE) {
      chunks.push(fileIds.slice(i, i + MAX_CONVEX_FILE_URL_BATCH_SIZE));
    }

    const chunkResults = await Promise.all(
      chunks.map(
        async (
          chunk,
          index,
        ): Promise<(ResolvedFileUrlInfo | string | null)[]> => {
          try {
            return await getConvexClient().action(
              api.s3Actions.getFileUrlInfosByFileIdsAction,
              {
                serviceKey,
                userId,
                fileIds: chunk as Id<"files">[],
              },
            );
          } catch (error) {
            logger.warn("file_url_fetch_chunk_failed", {
              event: "file_url_fetch_chunk_failed",
              service: "chat-handler",
              error: stringifyRedactedError(error),
              file_count: fileIds.length,
              chunk_file_count: chunk.length,
              chunk_index: index,
              chunk_count: chunks.length,
            });

            try {
              return await getConvexClient().action(
                api.s3Actions.getFileUrlsByFileIdsAction,
                {
                  serviceKey,
                  userId,
                  fileIds: chunk as Id<"files">[],
                },
              );
            } catch (fallbackError) {
              logger.warn("file_url_legacy_fetch_chunk_failed", {
                event: "file_url_legacy_fetch_chunk_failed",
                service: "chat-handler",
                error: stringifyRedactedError(fallbackError),
                file_count: fileIds.length,
                chunk_file_count: chunk.length,
                chunk_index: index,
                chunk_count: chunks.length,
              });
              return chunk.map(() => null);
            }
          }
        },
      ),
    );

    return chunkResults.flat();
  } catch (error) {
    logger.warn("file_url_fetch_failed", {
      event: "file_url_fetch_failed",
      service: "chat-handler",
      error: stringifyRedactedError(error),
      file_count: fileIds.length,
    });
    return [];
  }
};

const applyUrlsToFileParts = async (
  messages: UIMessage[],
  filesToProcess: Map<string, FileToProcess>,
  mode: ChatMode,
  userId: string,
) => {
  const filesNeedingUrls = Array.from(filesToProcess.values()).filter(
    (file) => file.fileId && !file.url,
  );
  const fileIdsNeedingUrls = filesNeedingUrls.map((file) => file.fileId!);

  const fetchedUrls = await fetchFileUrls(fileIdsNeedingUrls, userId);

  filesNeedingUrls.forEach((file, index) => {
    const resolved = validateResolvedFileUrlInfo(
      fetchedUrls[index],
      file.fileId!,
    );
    if (resolved) {
      file.url = resolved.url;
      if (typeof resolved.sizeBytes === "number") {
        file.sizeBytes = resolved.sizeBytes;
      }
      if (!file.mediaType && resolved.mediaType) {
        file.mediaType = resolved.mediaType;
      }
    }
  });

  for (const [fileKey, file] of filesToProcess) {
    if (!file.url) continue;

    // Only convert PDFs to base64 in "ask" mode for inline viewing.
    // In "agent" mode, we want the original URL for sandbox curl download.
    const finalUrl =
      mode === "ask" && file.mediaType === "application/pdf"
        ? await convertUrlToBase64DataUrl(file.url, "application/pdf").catch(
            () => file.url!,
          )
        : file.url;

    const normalizedMediaType =
      normalizeImageMediaType(file.mediaType) ?? file.mediaType;
    const isSupportedImage = isSupportedImageMediaType(
      normalizedMediaType ?? "",
    );
    const trustedImageSize =
      typeof file.sizeBytes === "number"
        ? ({ bytes: file.sizeBytes, source: "file_record" } as const)
        : null;
    const shouldProbeImageSize =
      isSupportedImage && file.url && mode !== "agent" && !trustedImageSize;
    const probedImageSize = shouldProbeImageSize
      ? await probeImageSize(file.url, MAX_IMAGE_SIZE)
      : null;
    const effectiveImageSize = trustedImageSize ?? probedImageSize;
    const imageLimit =
      effectiveImageSize &&
      effectiveImageSize.bytes > MAX_PROVIDER_IMAGE_DOWNLOAD_SIZE
        ? MAX_PROVIDER_IMAGE_DOWNLOAD_SIZE
        : MAX_IMAGE_SIZE;
    const shouldOmitImage =
      isSupportedImage &&
      effectiveImageSize != null &&
      effectiveImageSize.bytes > imageLimit;
    const shouldOmitUnverifiedImage =
      isSupportedImage &&
      mode !== "agent" &&
      !!file.url &&
      effectiveImageSize == null;
    const shouldValidateImage =
      isSupportedImage &&
      !!file.url &&
      !shouldOmitImage &&
      !shouldOmitUnverifiedImage;
    const imageValidation = shouldValidateImage
      ? await validateImageUrl(file.url, normalizedMediaType, imageLimit)
      : null;
    const shouldOmitInvalidImage = imageValidation?.valid === false;

    if (imageValidation?.valid) {
      file.mediaType = imageValidation.mediaType;
    }

    if (
      (shouldOmitImage ||
        shouldOmitUnverifiedImage ||
        shouldOmitInvalidImage) &&
      mode !== "agent"
    ) {
      logger.warn("image_attachment_omitted_before_provider_call", {
        event: "image_attachment_omitted_before_provider_call",
        service: "chat-handler",
        file_id: file.fileId,
        file_ref: file.fileId ? "file_id" : "inline_url",
        file_key: file.fileId ? fileKey : undefined,
        media_type: file.mediaType,
        size_bytes: effectiveImageSize?.bytes,
        limit_bytes: imageLimit,
        size_source: effectiveImageSize?.source,
        reason: shouldOmitImage
          ? "size_exceeded"
          : shouldOmitUnverifiedImage
            ? "size_unverified"
            : "invalid_image",
        validation_reason:
          imageValidation && !imageValidation.valid
            ? imageValidation.reason
            : undefined,
        detected_media_type:
          imageValidation && !imageValidation.valid
            ? imageValidation.detectedMediaType
            : undefined,
        mode,
      });
    }

    file.positions.forEach(({ messageIndex, partIndex }) => {
      const filePart = messages[messageIndex].parts![partIndex] as any;
      if (filePart.type !== "file") return;
      if (typeof file.sizeBytes === "number") {
        filePart.size = file.sizeBytes;
      }
      if (file.mediaType) {
        filePart.mediaType =
          normalizeImageMediaType(file.mediaType) ?? file.mediaType;
      }

      if ((shouldOmitImage || shouldOmitInvalidImage) && mode === "agent") {
        filePart.url = finalUrl;
        providerUnsafeImageParts.add(filePart);
      } else if (shouldOmitImage && mode !== "agent") {
        messages[messageIndex].parts![partIndex] = {
          type: "text",
          text: imageOmittedText(
            filePart.name,
            effectiveImageSize!.bytes,
            imageLimit,
          ),
        };
      } else if (shouldOmitUnverifiedImage) {
        messages[messageIndex].parts![partIndex] = {
          type: "text",
          text: unverifiedImageOmittedText(filePart.name),
        };
      } else if (shouldOmitInvalidImage) {
        messages[messageIndex].parts![partIndex] = {
          type: "text",
          text: invalidImageOmittedText(filePart.name),
        };
      } else {
        filePart.url = finalUrl;
      }
    });
  }
};

/**
 * Removes file parts that don't have a URL (failed to fetch).
 * These would cause AI_InvalidPromptError since file parts require actual content.
 */
const removeFilePartsWithoutUrls = (messages: UIMessage[]) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = msg.parts.filter(
      (part: any) => part?.type !== "file" || !!part.url,
    );
  });
};

const isProviderVisibleAgentImagePart = (part: any): boolean => {
  if (part?.type !== "file") return false;
  if (providerUnsafeImageParts.has(part)) return false;
  const mediaType = part.mediaType ?? "";
  if (!isSupportedImageMediaType(mediaType)) return false;

  const size =
    typeof part.size === "number"
      ? part.size
      : typeof part.sizeBytes === "number"
        ? part.sizeBytes
        : 0;

  return !isSandboxOnlyAgentUpload({
    mode: "agent",
    size,
    mediaType,
  });
};

const applyModeSpecificTransforms = async (
  messages: UIMessage[],
  mode: ChatMode,
  userId: string,
  sandboxFiles: SandboxFile[],
  uploadBasePath?: string,
  maxFileTokens?: number,
  allowLocalDesktopFiles?: boolean,
) => {
  const fileIds = extractAllFileIdsFromMessages(messages);

  if (mode === "agent") {
    collectSandboxFiles(messages, sandboxFiles, uploadBasePath, {
      allowLocalDesktopFiles,
      getAttachmentTagKind: (part) =>
        isProviderVisibleAgentImagePart(part) ? "inline-image" : "attachment",
    });
    removeNonMediaAndOversizedImageFileParts(messages);
  } else {
    const nonMediaFileIds = filterNonMediaFileIds(messages, fileIds);
    if (nonMediaFileIds.length > 0) {
      await addDocumentContentToMessages(
        messages,
        nonMediaFileIds,
        userId,
        maxFileTokens,
      );
    }
    removeAudioFileParts(messages);
  }

  // Remove any file parts that failed to get URLs to prevent AI_InvalidPromptError
  removeFilePartsWithoutUrls(messages);
};

/**
 * Processes all file attachments in messages for AI model consumption
 *
 * Transforms file parts based on chat mode:
 * - **Ask mode**: Converts non-media files to document content, keeps images/PDFs as file parts
 * - **Agent mode**: Prepares all files for sandbox upload, keeps only images as file parts
 *
 * Processing steps:
 * 1. Generates fresh URLs for files (prevents expiration)
 * 2. Converts PDFs to base64 for inline viewing
 * 3. Detects media files (images/PDFs)
 * 4. Applies mode-specific transforms:
 *    - Ask: Injects document content for text files, removes audio
 *    - Agent: Collects files for sandbox, adds attachment tags, removes non-images
 *
 * @param messages - Messages to process
 * @param mode - Chat mode ("ask" or "agent")
 * @param userId - Authenticated requester used to authorize stored file IDs
 * @param uploadBasePath - Override for agent mode (/home/user/upload or /tmp/hackerai-upload for local dangerous)
 * @returns Processed messages with file metadata and sandbox files for upload
 */
export const processMessageFiles = async (
  messages: UIMessage[],
  mode: ChatMode,
  userId: string,
  uploadBasePath?: string,
  subscription?: SubscriptionTier,
  allowLocalDesktopFiles: boolean = false,
): Promise<{
  messages: UIMessage[];
  hasMediaFiles: boolean;
  sandboxFiles: SandboxFile[];
  containsPdfFiles: boolean;
}> => {
  if (!messages.length) {
    return {
      messages,
      hasMediaFiles: false,
      sandboxFiles: [],
      containsPdfFiles: false,
    };
  }

  const updatedMessages = JSON.parse(JSON.stringify(messages)) as UIMessage[];
  const sandboxFiles: SandboxFile[] = [];

  if (mode !== "agent") {
    replaceOversizedImageParts(updatedMessages);
  }
  replaceUntrustedImageUrlParts(updatedMessages);

  const { hasMedia, files } = collectFilesToProcess(updatedMessages, mode);

  if (files.size > 0) {
    await applyUrlsToFileParts(updatedMessages, files, mode, userId);
  }

  const maxFileTokens = subscription
    ? getMaxFileTokens(subscription)
    : undefined;

  await applyModeSpecificTransforms(
    updatedMessages,
    mode,
    userId,
    sandboxFiles,
    uploadBasePath,
    maxFileTokens,
    allowLocalDesktopFiles,
  );

  return {
    messages: updatedMessages,
    hasMediaFiles: hasMedia,
    sandboxFiles,
    containsPdfFiles: containsPdfAttachments(updatedMessages),
  };
};

const filterNonMediaFileIds = (
  messages: UIMessage[],
  fileIds: Id<"files">[],
): Id<"files">[] => {
  const mediaFileIds = new Set<string>();

  messages.forEach((msg) => {
    if (!msg.parts) return;
    (msg.parts as any[]).forEach((part) => {
      if (part.type === "file" && part.fileId && isMediaFile(part.mediaType)) {
        mediaFileIds.add(part.fileId);
      }
    });
  });

  return fileIds.filter((fileId) => !mediaFileIds.has(fileId));
};

const formatDocument = (
  id: string,
  name: string,
  content: string,
) => `<document id="${id}">
<source>${name}</source>
<document_content>${content}</document_content>
</document>`;

const formatUnprocessableDocument = (name: string, reason: string) =>
  `<document>
<source>${name}</source>
<document_content>${reason}</document_content>
</document>`;

const addDocumentContentToMessages = async (
  messages: UIMessage[],
  fileIds: Id<"files">[],
  userId: string | undefined,
  maxFileTokens: number = getMaxFileTokens("pro"),
): Promise<void> => {
  if (!fileIds.length || !messages.length) return;
  if (!userId) {
    logger.warn("document_content_fetch_skipped_missing_user_id", {
      event: "document_content_fetch_skipped_missing_user_id",
      service: "chat-handler",
      file_count: fileIds.length,
    });
    return;
  }

  try {
    const fileContents = await getConvexClient().query(
      api.fileStorage.getFileContentByFileIds,
      { serviceKey, userId, fileIds },
    );

    const processableFiles = new Map<
      string,
      { name: string; content: string }
    >();
    const unprocessableFiles = new Map<
      string,
      { name: string; reason: string }
    >();

    fileContents.forEach((file: FileContent) => {
      // Check if file exceeds token limit for ask mode
      if (file.tokenSize > maxFileTokens) {
        unprocessableFiles.set(file.id, {
          name: file.name,
          reason: `This file is too large for ask mode (${file.tokenSize.toLocaleString()} tokens, limit: ${maxFileTokens.toLocaleString()} tokens). Please use agent mode to access this file, where you can use terminal tools to analyze it.`,
        });
      } else if (file.content?.trim()) {
        processableFiles.set(file.id, {
          name: file.name,
          content: file.content,
        });
      } else {
        unprocessableFiles.set(file.id, {
          name: file.name,
          reason:
            "This file has no readable text content. If you need to process this file, please use agent mode where you can use terminal tools to analyze binary or complex file formats.",
        });
      }
    });

    messages.forEach((msg) => {
      if (!msg.parts) return;

      const documents: string[] = [];
      const fileIdsToRemove = new Set<string>();

      (msg.parts as any[]).forEach((part) => {
        if (part.type !== "file" || !part.fileId) return;

        if (unprocessableFiles.has(part.fileId)) {
          const { name, reason } = unprocessableFiles.get(part.fileId)!;
          documents.push(formatUnprocessableDocument(name, reason));
          fileIdsToRemove.add(part.fileId);
        } else if (processableFiles.has(part.fileId)) {
          const { name, content } = processableFiles.get(part.fileId)!;
          documents.push(formatDocument(part.fileId, name, content));
          fileIdsToRemove.add(part.fileId);
        }
      });

      if (documents.length > 0) {
        msg.parts.unshift({
          type: "text",
          text: `<documents>\n${documents.join("\n\n")}\n</documents>`,
        });
        msg.parts = msg.parts.filter(
          (part: any) =>
            part.type !== "file" || !fileIdsToRemove.has(part.fileId),
        );
      }
    });
  } catch (error) {
    logger.warn("document_content_fetch_failed", {
      event: "document_content_fetch_failed",
      service: "chat-handler",
      error: stringifyRedactedError(error),
      file_count: fileIds.length,
    });
  }
};

const pruneFileParts = (
  messages: UIMessage[],
  shouldKeep: (mediaType?: string) => boolean,
) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = msg.parts.filter(
      (part: any) => part?.type !== "file" || shouldKeep(part.mediaType),
    );
  });
};

const removeNonMediaAndOversizedImageFileParts = (messages: UIMessage[]) => {
  messages.forEach((msg) => {
    if (!msg.parts) return;
    msg.parts = msg.parts.filter((part: any) => {
      if (part?.type !== "file") return true;
      if (providerUnsafeImageParts.has(part)) return false;
      if (!isSupportedImageMediaType(part.mediaType ?? "")) return false;
      return !isSandboxOnlyAgentUpload({
        mode: "agent",
        size:
          typeof part.size === "number"
            ? part.size
            : typeof part.sizeBytes === "number"
              ? part.sizeBytes
              : 0,
        mediaType: part.mediaType ?? "",
      });
    });
  });
};

const removeAudioFileParts = (messages: UIMessage[]) =>
  pruneFileParts(messages, (mediaType) => !mediaType?.startsWith("audio/"));
