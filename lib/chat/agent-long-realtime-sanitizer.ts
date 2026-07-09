export type AgentLongStreamChunk = Record<string, unknown> & {
  type?: string;
  id?: string;
};

const encoder = new TextEncoder();

// Trigger's realtime stream rejects records just under 1 MiB. Keep a buffer for
// JSON/envelope overhead before chunks are piped to agentUiStream.
export const AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES = 900_000;
export const AGENT_LONG_REALTIME_STRING_SLICE_CHARS = 8_000;
export const AGENT_LONG_REALTIME_DELTA_SLICE_CHARS = 180_000;

const TRUNCATED_MARKER = "[truncated for realtime stream]";

const getSerializedBytes = (value: unknown): number => {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
};

const truncateMiddle = (
  value: string,
  maxChars = AGENT_LONG_REALTIME_STRING_SLICE_CHARS,
): string => {
  if (value.length <= maxChars) return value;
  const head = Math.floor(maxChars * 0.7);
  const tail = Math.max(0, maxChars - head);
  const omittedChars = value.length - maxChars;
  const notice = `...${TRUNCATED_MARKER} ${omittedChars} chars omitted...`;
  return `${value.slice(0, head)}\n${notice}\n${value.slice(-tail)}`;
};

const makeRealtimePlaceholder = (
  value: unknown,
  context: string,
): Record<string, unknown> => {
  const originalBytes = getSerializedBytes(value);
  const preview =
    typeof value === "string"
      ? truncateMiddle(value)
      : truncateMiddle(safeStringify(value));

  return {
    __hackeraiRealtimeTruncated: true,
    context,
    originalBytes,
    preview,
  };
};

const compactValueForRealtime = (
  value: unknown,
  context: string,
  depth = 0,
  seen = new WeakSet<object>(),
): unknown => {
  if (typeof value === "string") {
    return truncateMiddle(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  if (seen.has(value)) {
    return "[circular]";
  }
  seen.add(value);

  if (depth >= 4) {
    return makeRealtimePlaceholder(value, `${context}.depth`);
  }

  if (Array.isArray(value)) {
    const maxItems = 25;
    const compacted = value
      .slice(0, maxItems)
      .map((item, index) =>
        compactValueForRealtime(item, `${context}[${index}]`, depth + 1, seen),
      );
    if (value.length > maxItems) {
      compacted.push({
        __hackeraiRealtimeTruncated: true,
        omittedItems: value.length - maxItems,
      });
    }
    return compacted;
  }

  const compacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    compacted[key] = compactValueForRealtime(
      child,
      `${context}.${key}`,
      depth + 1,
      seen,
    );
  }

  if (
    getSerializedBytes(compacted) >
    AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES / 2
  ) {
    return makeRealtimePlaceholder(value, context);
  }

  return compacted;
};

const compactErrorText = (value: unknown): unknown =>
  typeof value === "string" ? truncateMiddle(value, 4_000) : value;

const splitString = (
  value: string,
  getCandidateBytes?: (candidate: string) => number,
): string[] | null => {
  const candidateFits = (candidate: string) => {
    const bytes =
      getCandidateBytes?.(candidate) ?? encoder.encode(candidate).byteLength;
    return bytes <= AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES;
  };

  if (candidateFits(value)) {
    return [value];
  }

  const parts: string[] = [];
  let index = 0;
  while (index < value.length) {
    let end = Math.min(
      value.length,
      index + AGENT_LONG_REALTIME_DELTA_SLICE_CHARS,
    );
    let part = value.slice(index, end);

    while (part.length > 1 && !candidateFits(part)) {
      end = index + Math.max(1, Math.floor(part.length * 0.8));
      part = value.slice(index, end);
    }

    if (!candidateFits(part)) {
      return null;
    }

    parts.push(part);
    index = end;
  }
  return parts;
};

const withSplitStringField = (
  chunk: AgentLongStreamChunk,
  field: string,
): AgentLongStreamChunk[] | null => {
  const value = chunk[field];
  if (typeof value !== "string") return null;

  const parts = splitString(value, (candidate) =>
    getSerializedBytes({ ...chunk, [field]: candidate }),
  );
  if (!parts) return null;
  if (parts.length === 1) return null;

  return parts.map((part) => ({
    ...chunk,
    [field]: part,
  }));
};

const withSplitNestedStringField = (
  chunk: AgentLongStreamChunk,
  containerField: string,
  field: string,
): AgentLongStreamChunk[] | null => {
  const container = chunk[containerField];
  if (!container || typeof container !== "object" || Array.isArray(container)) {
    return null;
  }

  const value = (container as Record<string, unknown>)[field];
  if (typeof value !== "string") return null;

  const parts = splitString(value, (candidate) =>
    getSerializedBytes({
      ...chunk,
      [containerField]: {
        ...container,
        [field]: candidate,
      },
    }),
  );
  if (!parts) return null;
  if (parts.length === 1) return null;

  const baseId = typeof chunk.id === "string" ? chunk.id : chunk.type;
  return parts.map((part, index) => ({
    ...chunk,
    id: `${baseId}-${index + 1}`,
    [containerField]: {
      ...container,
      [field]: part,
    },
  }));
};

const compactKnownOversizedChunk = (
  chunk: AgentLongStreamChunk,
): AgentLongStreamChunk => {
  switch (chunk.type) {
    case "tool-input-error":
      return {
        ...chunk,
        input: compactValueForRealtime(chunk.input, "tool-input-error.input"),
        errorText: compactErrorText(chunk.errorText),
      };
    case "tool-input-available":
      return {
        ...chunk,
        input: compactValueForRealtime(
          chunk.input,
          "tool-input-available.input",
        ),
      };
    case "tool-output-available":
      return {
        ...chunk,
        output: compactValueForRealtime(
          chunk.output,
          "tool-output-available.output",
        ),
      };
    case "tool-output-error":
    case "error":
      return {
        ...chunk,
        errorText: compactErrorText(chunk.errorText),
        error: compactErrorText(chunk.error),
      };
    default:
      return {
        type: "data-agent-stream-warning",
        data: makeRealtimePlaceholder(chunk, "ui-chunk"),
        transient: true,
      };
  }
};

const minimalKnownChunk = (
  chunk: AgentLongStreamChunk,
  originalBytes: number,
): AgentLongStreamChunk => {
  const base = {
    type: chunk.type,
    toolCallId: chunk.toolCallId,
    toolName: chunk.toolName,
    dynamic: chunk.dynamic,
  };
  const placeholder = {
    __hackeraiRealtimeTruncated: true,
    originalBytes,
    message:
      "This payload was too large for the realtime stream and was compacted.",
  };

  switch (chunk.type) {
    case "tool-input-error":
      return {
        ...base,
        input: placeholder,
        errorText:
          "Tool input was too large to stream in full and was compacted.",
      };
    case "tool-input-available":
      return {
        ...base,
        input: placeholder,
      };
    case "tool-output-available":
      return {
        ...base,
        output: placeholder,
      };
    case "tool-output-error":
      return {
        ...base,
        errorText:
          "Tool error payload was too large to stream in full and was compacted.",
      };
    default:
      return {
        type: "data-agent-stream-warning",
        data: placeholder,
        transient: true,
      };
  }
};

export const sanitizeAgentLongRealtimeChunk = (
  chunk: AgentLongStreamChunk,
): AgentLongStreamChunk[] => {
  const splitDelta =
    (chunk.type === "text-delta" || chunk.type === "reasoning-delta") &&
    withSplitStringField(chunk, "delta");
  if (splitDelta) return splitDelta;

  const splitToolInput =
    chunk.type === "tool-input-delta" &&
    withSplitStringField(chunk, "inputTextDelta");
  if (splitToolInput) return splitToolInput;

  const splitTerminal =
    chunk.type === "data-terminal" &&
    withSplitNestedStringField(chunk, "data", "terminal");
  if (splitTerminal) return splitTerminal;

  const originalBytes = getSerializedBytes(chunk);
  if (originalBytes <= AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES) {
    return [chunk];
  }

  const compacted = compactKnownOversizedChunk(chunk);
  if (getSerializedBytes(compacted) <= AGENT_LONG_REALTIME_SAFE_CHUNK_BYTES) {
    return [compacted];
  }

  return [minimalKnownChunk(chunk, originalBytes)];
};
