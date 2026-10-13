import "server-only";

import { createHash } from "node:crypto";
import type { UIMessage } from "ai";
import {
  exceedsAbliterationImageLimit,
  type AbliterationImageMessages,
} from "@/lib/ai/abliteration-media";
import {
  AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS,
  AUXILIARY_VISION_RECOVERY_TIMEOUT_MS,
  AuxiliaryVisionTimeoutError,
  describeImageWithAuxiliaryVision,
  getCachedAuxiliaryVisionDescription,
  type AuxiliaryVisionDescriptionCacheWriter,
} from "./auxiliary-vision";
import {
  extractErrorDetails,
  getProviderErrorCategory,
} from "@/lib/utils/error-utils";

export class AbliterationVisionError extends Error {
  readonly origin = "auxiliary_vision";
  constructor(cause?: unknown) {
    super(
      "Image analysis could not be completed. Please retry or send fewer images.",
      { cause },
    );
    this.name = "AbliterationVisionError";
  }
}

type ImageInput = { image: string; mediaType: string; filename?: string };

/** Reads the SDK's attachment and multimodal tool-output image representations. */
function imageInput(part: unknown): ImageInput | undefined {
  if (!part || typeof part !== "object") return;
  const value = part as Record<string, unknown>;
  const type = value.type;
  const mediaType =
    typeof value.mediaType === "string" ? value.mediaType : undefined;
  if (
    !["image", "image-data", "image-url"].includes(String(type)) &&
    !(
      ["file", "file-data", "file-url"].includes(String(type)) &&
      mediaType?.startsWith("image/")
    )
  )
    return;
  const data = value.image ?? value.data ?? value.url;
  const image =
    typeof data === "string"
      ? data
      : data instanceof URL
        ? data.href
        : data instanceof Uint8Array
          ? Buffer.from(data).toString("base64")
          : data instanceof ArrayBuffer
            ? Buffer.from(data).toString("base64")
            : undefined;
  if (!image) throw new AbliterationVisionError();
  return {
    image,
    mediaType: mediaType ?? /^data:([^;,]+)/.exec(image)?.[1] ?? "image/png",
    ...(typeof value.filename === "string" && { filename: value.filename }),
  };
}

// SDK conversion decodes data URLs to bytes. Match those to their trusted UI
// attachments without storing a second copy of the image payload.
const imageCacheKey = ({ image, mediaType }: ImageInput) =>
  createHash("sha256")
    .update(mediaType)
    .update("\0")
    .update(image.replace(/^data:[^,]*;base64,/, ""))
    .digest("hex");

/** Reuses existing OCR calls in batches of <=4; only the outbound copy is changed. */
export function createAbliterationVisionPreprocessor({
  userId,
  chatId,
  requestId,
  triggerRunId,
  abortSignal,
  onCost,
  describe = describeImageWithAuxiliaryVision,
  getAttachmentMessages,
  cacheDescription,
}: {
  userId: string;
  chatId: string;
  requestId?: string;
  triggerRunId?: string;
  abortSignal: AbortSignal;
  onCost: (cost: number) => void;
  describe?: typeof describeImageWithAuxiliaryVision;
  /** Only messages whose file metadata was reloaded through the owner check. */
  getAttachmentMessages?: () => UIMessage[];
  cacheDescription?: AuxiliaryVisionDescriptionCacheWriter;
}) {
  // Store only summaries/hashes, not duplicate image payloads. Retain rejected
  // promises too so error recovery cannot repeat an already failed OCR batch.
  const cache = new Map<string, Promise<string>>();
  return async <T extends AbliterationImageMessages>(
    messages: T,
    options?: { force?: boolean },
  ): Promise<T> => {
    if (!options?.force && !exceedsAbliterationImageLimit(messages))
      return messages;
    const tasks: Array<{
      position: string;
      input: ImageInput;
      source: "attachment" | "file_view";
    }> = [];
    for (const [mi, message] of messages.entries()) {
      if (!Array.isArray(message.content)) continue;
      for (const [pi, part] of message.content.entries()) {
        const input = imageInput(part);
        if (input)
          tasks.push({ position: `${mi}:${pi}`, input, source: "attachment" });
        if (part.type === "tool-result" && part.output.type === "content") {
          for (const [oi, output] of part.output.value.entries()) {
            const input = imageInput(output);
            if (input)
              tasks.push({
                position: `${mi}:${pi}:${oi}`,
                input,
                source: "file_view",
              });
          }
        }
      }
    }
    if (tasks.length === 0) return messages;
    const attachments = new Map<
      string,
      Array<{ fileId: string; description?: string }>
    >();
    for (const message of getAttachmentMessages?.() ?? []) {
      for (const part of message.parts ?? []) {
        if (part.type !== "file") continue;
        const record = part as unknown as Record<string, unknown>;
        if (typeof record.fileId !== "string") continue;
        const input = imageInput(part);
        if (!input) continue;
        const key = imageCacheKey(input);
        const entries = attachments.get(key) ?? [];
        if (!entries.some((entry) => entry.fileId === record.fileId)) {
          entries.push({
            fileId: record.fileId,
            description: getCachedAuxiliaryVisionDescription(record),
          });
          attachments.set(key, entries);
        }
      }
    }
    const recoveryController = new AbortController();
    const recoveryTimeout = setTimeout(
      () =>
        recoveryController.abort(
          new AuxiliaryVisionTimeoutError(AUXILIARY_VISION_RECOVERY_TIMEOUT_MS),
        ),
      AUXILIARY_VISION_RECOVERY_TIMEOUT_MS,
    );
    const recoverySignal = AbortSignal.any([
      abortSignal,
      recoveryController.signal,
    ]);
    let spent = 0;
    const withinBudget = () =>
      spent < AUXILIARY_VISION_RECOVERY_COST_BUDGET_DOLLARS;
    const replacements = new Map<string, { type: "text"; text: string }>();
    try {
      for (let start = 0; start < tasks.length; start += 4) {
        recoverySignal.throwIfAborted();
        const results = await Promise.allSettled(
          tasks.slice(start, start + 4).map(async (task, offset) => {
            const key = imageCacheKey(task.input);
            // Tool screenshots are mutable and have no owned attachment identity.
            const ownedAttachments =
              task.source === "attachment" ? (attachments.get(key) ?? []) : [];
            let pending = cache.get(key);
            if (!pending) {
              const saved = ownedAttachments.find(
                (entry) => entry.description,
              )?.description;
              pending = saved
                ? Promise.resolve(saved)
                : (async () => {
                    if (!withinBudget())
                      throw new Error(
                        "Image analysis reached its cost budget. Please retry with fewer images.",
                      );
                    const result = await describe({
                      ...task.input,
                      source: task.source,
                      userId,
                      chatId,
                      requestId,
                      triggerRunId,
                      abortSignal: recoverySignal,
                      canRetry: withinBudget,
                      onCost: (cost) => {
                        spent += cost;
                        onCost(cost);
                      },
                    });
                    // Persist each completed image before a sibling failure is surfaced.
                    // Cache writes are best effort; the storage adapter logs failures.
                    if (cacheDescription)
                      await Promise.allSettled(
                        ownedAttachments.map(({ fileId }) =>
                          cacheDescription({
                            userId,
                            fileId,
                            description: result.description,
                            model: result.model,
                          }),
                        ),
                      );
                    return result.description;
                  })();
              cache.set(key, pending);
            }
            const description = await pending;
            if (!description.trim()) throw new AbliterationVisionError();
            const escaped = description
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;");
            const filename = task.input.filename
              ?.replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;");
            replacements.set(task.position, {
              type: "text",
              text: `<image_description index="${start + offset + 1}"${filename ? ` filename="${filename}"` : ""} trust="untrusted">\n${escaped}\n</image_description>`,
            });
          }),
        );
        recoverySignal.throwIfAborted();
        const failures = results.filter(
          (result): result is PromiseRejectedResult =>
            result.status === "rejected",
        );
        if (failures.length) {
          const timeout = failures.find(
            ({ reason }) =>
              getProviderErrorCategory(extractErrorDetails(reason)) ===
              "timeout",
          );
          throw new AbliterationVisionError((timeout ?? failures[0]).reason);
        }
      }
      return messages.map((message, mi) => {
        if (!Array.isArray(message.content)) return message;
        return {
          ...message,
          content: message.content.map((part, pi) => {
            if (part.type === "tool-result" && part.output.type === "content") {
              return {
                ...part,
                output: {
                  ...part.output,
                  value: part.output.value.map(
                    (output, oi) =>
                      replacements.get(`${mi}:${pi}:${oi}`) ?? output,
                  ),
                },
              };
            }
            return replacements.get(`${mi}:${pi}`) ?? part;
          }),
        };
      }) as T;
    } catch (error) {
      abortSignal.throwIfAborted();
      if (error instanceof AbliterationVisionError) throw error;
      throw new AbliterationVisionError(error);
    } finally {
      clearTimeout(recoveryTimeout);
    }
  };
}
