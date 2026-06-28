const STANDALONE_PROVIDER_REASONING_TAGS = ["</think>", "</mm:think>"];

type MessageWithParts = {
  role?: unknown;
  parts?: unknown[];
};

type ChunkLike = {
  type?: unknown;
  id?: unknown;
  delta?: unknown;
};

const normalizeText = (text: string) => text.trim();

export const isStandaloneProviderReasoningTagText = (text: string): boolean =>
  STANDALONE_PROVIDER_REASONING_TAGS.includes(normalizeText(text));

const isPotentialStandaloneProviderReasoningTagText = (
  text: string,
): boolean => {
  const leftTrimmed = text.trimStart();
  if (leftTrimmed === "") return true;

  return STANDALONE_PROVIDER_REASONING_TAGS.some((tag) => {
    if (tag.startsWith(leftTrimmed)) return true;
    if (!leftTrimmed.startsWith(tag)) return false;
    return leftTrimmed.slice(tag.length).trim() === "";
  });
};

export const isStandaloneProviderReasoningTagTextPart = (
  part: unknown,
): boolean => {
  if (!part || typeof part !== "object") return false;
  const record = part as { type?: unknown; text?: unknown };
  return (
    record.type === "text" &&
    typeof record.text === "string" &&
    isStandaloneProviderReasoningTagText(record.text)
  );
};

export const stripStandaloneProviderReasoningTagTextParts = <
  T extends unknown[],
>(
  parts: T,
): T => {
  const filtered = parts.filter(
    (part) => !isStandaloneProviderReasoningTagTextPart(part),
  );
  return filtered.length === parts.length ? parts : (filtered as T);
};

export const stripStandaloneProviderReasoningTagTextMessage = <
  T extends MessageWithParts,
>(
  message: T,
): T => {
  if (message.role != null && message.role !== "assistant") {
    return message;
  }
  if (!Array.isArray(message.parts)) return message;

  const parts = stripStandaloneProviderReasoningTagTextParts(message.parts);
  if (parts === message.parts) return message;

  return { ...message, parts } as T;
};

export const stripStandaloneProviderReasoningTagTextMessages = <
  T extends MessageWithParts,
>(
  messages: T[],
): T[] => {
  let changed = false;
  const stripped = messages.map((message) => {
    const next = stripStandaloneProviderReasoningTagTextMessage(message);
    if (next !== message) changed = true;
    return next;
  });

  return changed ? stripped : messages;
};

export function filterStandaloneProviderReasoningTagTextStream<
  T extends ChunkLike,
>(stream: ReadableStream<T>): ReadableStream<T> {
  type TextBuffer = {
    chunks: T[];
    text: string;
    passthrough: boolean;
  };

  const textBuffers = new Map<string, TextBuffer>();

  const flushTextBuffer = (
    buffer: TextBuffer,
    controller: TransformStreamDefaultController<T>,
  ) => {
    for (const bufferedChunk of buffer.chunks) {
      controller.enqueue(bufferedChunk);
    }
    buffer.chunks = [];
    buffer.passthrough = true;
  };

  const flushOrDropTextBuffer = (
    buffer: TextBuffer,
    controller: TransformStreamDefaultController<T>,
  ) => {
    if (buffer.passthrough) {
      flushTextBuffer(buffer, controller);
      return;
    }
    if (!isStandaloneProviderReasoningTagText(buffer.text)) {
      flushTextBuffer(buffer, controller);
    }
  };

  const flushAllTextBuffers = (
    controller: TransformStreamDefaultController<T>,
  ) => {
    for (const [id, buffer] of textBuffers) {
      flushOrDropTextBuffer(buffer, controller);
      textBuffers.delete(id);
    }
  };

  return stream.pipeThrough(
    new TransformStream<T, T>({
      transform(chunk, controller) {
        const { type, id, delta } = chunk;

        if (type === "text-start" && typeof id === "string") {
          textBuffers.set(id, {
            chunks: [chunk],
            text: "",
            passthrough: false,
          });
          return;
        }

        if (
          type === "text-delta" &&
          typeof id === "string" &&
          typeof delta === "string"
        ) {
          const buffer = textBuffers.get(id);
          if (!buffer) {
            controller.enqueue(chunk);
            return;
          }

          if (buffer.passthrough) {
            controller.enqueue(chunk);
            return;
          }

          buffer.chunks.push(chunk);
          buffer.text += delta;

          if (!isPotentialStandaloneProviderReasoningTagText(buffer.text)) {
            flushTextBuffer(buffer, controller);
          }
          return;
        }

        if (type === "text-end" && typeof id === "string") {
          const buffer = textBuffers.get(id);
          if (!buffer) {
            controller.enqueue(chunk);
            return;
          }

          textBuffers.delete(id);
          if (buffer.passthrough) {
            controller.enqueue(chunk);
            return;
          }

          if (isStandaloneProviderReasoningTagText(buffer.text)) return;

          flushTextBuffer(buffer, controller);
          controller.enqueue(chunk);
          return;
        }

        flushAllTextBuffers(controller);
        controller.enqueue(chunk);
      },
      flush(controller) {
        flushAllTextBuffers(controller);
      },
    }),
  );
}
