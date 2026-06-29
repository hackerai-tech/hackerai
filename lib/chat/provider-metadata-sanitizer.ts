type MessageWithParts = {
  parts?: unknown[];
};

type SanitizePartResult = {
  part: unknown;
  changed: boolean;
  drop: boolean;
};

const PROVIDER_METADATA_KEYS = [
  "providerMetadata",
  "callProviderMetadata",
  "resultProviderMetadata",
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOwn = (value: Record<string, unknown>, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

function hasOpenRouterReasoningDetails(metadata: unknown): boolean {
  if (!isRecord(metadata)) return false;
  const openrouter = metadata.openrouter;
  return (
    isRecord(openrouter) &&
    Array.isArray(openrouter.reasoning_details) &&
    openrouter.reasoning_details.length > 0
  );
}

export function partHasOpenRouterReasoningDetails(part: unknown): boolean {
  if (!isRecord(part)) return false;
  return PROVIDER_METADATA_KEYS.some((key) =>
    hasOpenRouterReasoningDetails(part[key]),
  );
}

function stripOpenRouterReasoningDetailsFromMetadata(metadata: unknown): {
  metadata: unknown;
  changed: boolean;
} {
  if (!isRecord(metadata)) return { metadata, changed: false };

  const openrouter = metadata.openrouter;
  if (!isRecord(openrouter) || !hasOwn(openrouter, "reasoning_details")) {
    return { metadata, changed: false };
  }

  const { reasoning_details, ...openrouterRest } = openrouter;
  const cleanedMetadata = { ...metadata };
  if (Object.keys(openrouterRest).length > 0) {
    cleanedMetadata.openrouter = openrouterRest;
  } else {
    delete cleanedMetadata.openrouter;
  }

  return { metadata: cleanedMetadata, changed: true };
}

function sanitizeOpenRouterReasoningPartMetadata(
  part: unknown,
): SanitizePartResult {
  if (!isRecord(part)) return { part, changed: false, drop: false };

  if (part.type === "reasoning" && partHasOpenRouterReasoningDetails(part)) {
    return { part, changed: true, drop: true };
  }

  let changed = false;
  const cleanedPart = { ...part };

  for (const key of PROVIDER_METADATA_KEYS) {
    if (!hasOwn(cleanedPart, key)) continue;

    const result = stripOpenRouterReasoningDetailsFromMetadata(
      cleanedPart[key],
    );
    if (!result.changed) continue;

    changed = true;
    if (
      isRecord(result.metadata) &&
      Object.keys(result.metadata).length === 0
    ) {
      delete cleanedPart[key];
    } else {
      cleanedPart[key] = result.metadata;
    }
  }

  return changed
    ? { part: cleanedPart, changed, drop: false }
    : { part, changed: false, drop: false };
}

export function stripOpenRouterReasoningMetadataFromParts<T extends unknown[]>(
  parts: T,
): T {
  let changed = false;
  const nextParts: unknown[] = [];

  for (const part of parts) {
    const result = sanitizeOpenRouterReasoningPartMetadata(part);
    if (result.drop) {
      changed = true;
      continue;
    }
    if (result.changed) changed = true;
    nextParts.push(result.part);
  }

  return changed ? (nextParts as T) : parts;
}

export function stripOpenRouterReasoningMetadataFromMessage<
  T extends MessageWithParts,
>(message: T): T {
  if (!Array.isArray(message.parts)) return message;

  const parts = stripOpenRouterReasoningMetadataFromParts(message.parts);
  return parts === message.parts ? message : { ...message, parts };
}

export function stripOpenRouterReasoningMetadataFromMessages<
  T extends MessageWithParts,
>(messages: T[]): T[] {
  let changed = false;
  const nextMessages = messages.map((message) => {
    const sanitized = stripOpenRouterReasoningMetadataFromMessage(message);
    if (sanitized !== message) changed = true;
    return sanitized;
  });

  return changed ? nextMessages : messages;
}
