/**
 * Display-only Agent context pressure: the provider-reported input of the
 * last measured model request and the automatic compaction threshold that
 * was active for it. Never a forecast, and never sent back to a model.
 */
export const CONTEXT_USAGE_PART_TYPE = "data-context-usage";
export const CONTEXT_USAGE_SNAPSHOT_ID_PREFIX = "context-usage";

export type ContextPressureSnapshot = {
  usedTokens: number;
  compactionThresholdTokens: number;
};

type PartLike = { type?: unknown; data?: unknown };
type MessageLike = { role?: unknown; parts?: readonly unknown[] };

const isTokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Accepts only a measured request: a positive input count and a positive
 * threshold. Legacy `{ usedTokens, maxTokens }` parts carried model capacity,
 * not the compaction point, so they are rejected rather than reinterpreted.
 */
export function toContextPressureSnapshot(
  usedTokens: unknown,
  compactionThresholdTokens: unknown,
): ContextPressureSnapshot | null {
  if (
    !isTokenCount(usedTokens) ||
    usedTokens === 0 ||
    !isTokenCount(compactionThresholdTokens) ||
    compactionThresholdTokens === 0
  ) {
    return null;
  }
  return { usedTokens, compactionThresholdTokens };
}

export const isContextUsagePart = (part: unknown): boolean =>
  !!part &&
  typeof part === "object" &&
  (part as PartLike).type === CONTEXT_USAGE_PART_TYPE;

const readSnapshot = (part: unknown): ContextPressureSnapshot | null => {
  if (!isContextUsagePart(part)) return null;
  const data = (part as PartLike).data;
  if (!data || typeof data !== "object") return null;
  const fields = data as Record<string, unknown>;
  return toContextPressureSnapshot(
    fields.usedTokens,
    fields.compactionThresholdTokens,
  );
};

/** The last valid snapshot in one response, if it measured anything. */
export function getResponseContextPressure(
  message: MessageLike,
): ContextPressureSnapshot | null {
  if (message.role !== "assistant") return null;
  const parts = message.parts ?? [];
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const snapshot = readSnapshot(parts[index]);
    if (snapshot) return snapshot;
  }
  return null;
}

/**
 * Latest measurement among the loaded messages of one chat. A response that
 * has not measured yet falls back to the previous measured Agent request.
 */
export function selectLatestContextPressure(
  messages: readonly MessageLike[],
): ContextPressureSnapshot | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const snapshot = getResponseContextPressure(messages[index]);
    if (snapshot) return snapshot;
  }
  return null;
}

/** Share of the threshold used, unclamped so text stays honest above 100%. */
export const getContextPressurePercent = (
  snapshot: ContextPressureSnapshot,
): number => {
  const ratio = snapshot.usedTokens / snapshot.compactionThresholdTokens;
  const rounded = Math.round(ratio * 100);
  return ratio < 1 ? Math.min(99, rounded) : rounded;
};

export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  const thousands = Math.round(tokens / 1000);
  if (thousands < 1000) return `${thousands}k`;
  return `${Math.round(tokens / 100_000) / 10}M`;
}
