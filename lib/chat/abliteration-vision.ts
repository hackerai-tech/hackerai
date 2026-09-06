import "server-only";

import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";
import { exceedsAbliterationImageLimit } from "@/lib/ai/abliteration-media";
import { describeImageWithAuxiliaryVision } from "./auxiliary-vision";

export class AbliterationVisionError extends Error {
  constructor() {
    super(
      "Image analysis could not be completed. Please retry or send fewer images.",
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

/** Reuses existing OCR calls in batches of <=4; only the outbound copy is changed. */
export function createAbliterationVisionPreprocessor({
  userId,
  chatId,
  abortSignal,
  onCost,
  describe = describeImageWithAuxiliaryVision,
}: {
  userId: string;
  chatId: string;
  abortSignal: AbortSignal;
  onCost: (cost: number) => void;
  describe?: typeof describeImageWithAuxiliaryVision;
}) {
  // Store only summaries/hashes, not duplicate image payloads. Retain rejected
  // promises too so error recovery cannot repeat an already failed OCR batch.
  const cache = new Map<string, Promise<string>>();
  return async (messages: ModelMessage[]): Promise<ModelMessage[]> => {
    if (!exceedsAbliterationImageLimit(messages)) return messages;
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
    const replacements = new Map<string, { type: "text"; text: string }>();
    for (let start = 0; start < tasks.length; start += 4) {
      abortSignal.throwIfAborted();
      const results = await Promise.allSettled(
        tasks.slice(start, start + 4).map(async (task, offset) => {
          const key = createHash("sha256")
            .update(task.input.mediaType)
            .update("\0")
            .update(task.input.image)
            .digest("hex");
          let pending = cache.get(key);
          if (!pending) {
            pending = describe({
              ...task.input,
              source: task.source,
              userId,
              chatId,
              abortSignal,
              onCost,
            }).then((result) => result.description);
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
      abortSignal.throwIfAborted();
      if (results.some((result) => result.status === "rejected"))
        throw new AbliterationVisionError();
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
      } as ModelMessage;
    });
  };
}
