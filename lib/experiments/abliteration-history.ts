/** Server-owned metadata stored inside the existing messages.usage object. */
export type AbliterationRoutingMarker = {
  version: 1;
  source: "moderation" | "history";
  completed: boolean;
};

export type AbliterationHistoryEntry = {
  id: string;
  completed: boolean;
  independent: boolean;
};

export const ABLITERATION_HISTORY_WINDOW = 5;
export const ABLITERATION_HISTORY_THRESHOLD = 2;

export function getAbliterationHistoryEntry(message: {
  id: string;
  finish_reason?: string;
  usage?: unknown;
}): AbliterationHistoryEntry {
  const usage = message.usage;
  const marker =
    usage && typeof usage === "object" && "abliterationRouting" in usage
      ? usage.abliterationRouting
      : undefined;
  const completed = message.finish_reason === "stop";
  return {
    id: message.id,
    completed,
    independent:
      completed &&
      !!marker &&
      typeof marker === "object" &&
      "version" in marker &&
      marker.version === 1 &&
      "source" in marker &&
      marker.source === "moderation" &&
      "completed" in marker &&
      marker.completed === true,
  };
}

/** Input is newest-first, fetched by the authenticated backend, never client metadata. */
export function countIndependentAbliterationResponses(
  entries: AbliterationHistoryEntry[],
): number {
  const seen = new Set<string>();
  return entries
    .filter((entry) => {
      if (seen.has(entry.id)) return false;
      seen.add(entry.id);
      return entry.completed;
    })
    .slice(0, ABLITERATION_HISTORY_WINDOW)
    .filter((entry) => entry.independent).length;
}

/** Client stop-save can preserve usage, but cannot assert routing provenance. */
export function stripClientAbliterationRouting(usage: unknown): unknown {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return usage;
  const { abliterationRouting: _untrusted, ...rest } = usage as Record<
    string,
    unknown
  >;
  return rest;
}
