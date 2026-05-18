import type { UIMessagePart } from "ai";

const UNKNOWN_PART_TYPE = "unknown";

const getByteLength = (value: unknown): number => {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf-8");
  } catch {
    return 0;
  }
};

const getPartType = (part: unknown): string => {
  if (!part || typeof part !== "object") return UNKNOWN_PART_TYPE;
  const type = (part as { type?: unknown }).type;
  return typeof type === "string" && type.length > 0 ? type : UNKNOWN_PART_TYPE;
};

export function getMessagePersistenceDiagnostics(
  parts: UIMessagePart<any, any>[],
) {
  const partTypes: Record<string, number> = {};
  let largestPartType = UNKNOWN_PART_TYPE;
  let largestPartSizeBytes = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolPartCount = 0;
  let dataPartCount = 0;
  let stepStartCount = 0;

  for (const part of parts) {
    const partType = getPartType(part);
    partTypes[partType] = (partTypes[partType] ?? 0) + 1;

    const partSizeBytes = getByteLength(part);
    if (partSizeBytes > largestPartSizeBytes) {
      largestPartType = partType;
      largestPartSizeBytes = partSizeBytes;
    }

    if (partType === "text") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") textChars += text.length;
    } else if (partType === "reasoning") {
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") reasoningChars += text.length;
    } else if (partType === "step-start") {
      stepStartCount++;
    }

    if (partType.startsWith("tool-") || partType === "dynamic-tool") {
      toolPartCount++;
    }
    if (partType.startsWith("data-")) {
      dataPartCount++;
    }
  }

  const partsSizeBytes = getByteLength(parts);

  return {
    part_count: parts.length,
    parts_size_bytes: partsSizeBytes,
    parts_size_kb: Math.round(partsSizeBytes / 1024),
    part_types: partTypes,
    largest_part_type: largestPartType,
    largest_part_size_bytes: largestPartSizeBytes,
    largest_part_size_kb: Math.round(largestPartSizeBytes / 1024),
    text_chars: textChars,
    reasoning_chars: reasoningChars,
    tool_part_count: toolPartCount,
    data_part_count: dataPartCount,
    step_start_count: stepStartCount,
  };
}
