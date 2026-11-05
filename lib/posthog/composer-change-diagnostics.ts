import { getIdentifiedAnalyticsUserId } from "@/lib/analytics/client";

const WINDOW_MS = 5000;
const MAX_CHANGES = 64;
const INPUT_TYPES = new Set([
  "insertText",
  "insertCompositionText",
  "insertReplacementText",
  "insertFromPaste",
  "insertFromDrop",
  "insertLineBreak",
  "deleteContentBackward",
  "deleteContentForward",
  "deleteWordBackward",
  "deleteByCut",
  "historyUndo",
  "historyRedo",
]);
type Change = {
  at: number;
  inputType: string;
  trusted: boolean | undefined;
  composing: boolean;
};
const changes: Array<Change | undefined> = new Array(MAX_CHANGES);
let next = 0;
let owner: string | null = null;

function identifiedOwner() {
  const current = getIdentifiedAnalyticsUserId();
  if (current !== owner || !current) {
    changes.fill(undefined);
    next = 0;
    owner = current;
  }
  return current;
}

/** Never retain an event, input content, target, selection, or arbitrary strings. */
export function recordComposerChange(nativeEvent: unknown): void {
  try {
    if (!identifiedOwner() || !nativeEvent || typeof nativeEvent !== "object")
      return;
    const at = performance.now();
    if (!Number.isFinite(at) || at < 0) return;
    const event = nativeEvent as Record<string, unknown>;
    const inputType = event.inputType;
    const trusted = event.isTrusted;
    const composing = event.isComposing;
    changes[next] = {
      at,
      inputType:
        inputType === undefined || inputType === ""
          ? "none"
          : typeof inputType === "string" &&
              inputType.length <= 32 &&
              INPUT_TYPES.has(inputType)
            ? inputType
            : "other",
      trusted: typeof trusted === "boolean" ? trusted : undefined,
      composing: composing === true,
    };
    next = (next + 1) % MAX_CHANGES;
  } catch {
    // Diagnostics must never interrupt typing, including during composition.
  }
}

/** Counts are capped, recent observations, not proof of what caused a React loop. */
export function getComposerChangeDiagnostics(): Record<
  string,
  string | number
> {
  try {
    if (!identifiedOwner()) return {};
    const now = performance.now();
    if (!Number.isFinite(now) || now < 0) return {};
    const recent: Change[] = [];
    // Walk oldest to newest so equal clock ticks still select the last event
    // after the ring wraps.
    for (let offset = 0; offset < changes.length; offset++) {
      const i = (next + offset) % MAX_CHANGES;
      const change = changes[i];
      if (!change) continue;
      const age = now - change.at;
      if (age < 0 || age >= WINDOW_MS) changes[i] = undefined;
      else recent.push(change);
    }
    const last = recent.reduce<Change | undefined>(
      (latest, change) => (!latest || change.at >= latest.at ? change : latest),
      undefined,
    );
    return {
      hackerai_composer_change_recent_count: recent.length,
      hackerai_composer_change_burst_count: last
        ? recent.filter((change) => last.at - change.at <= 100).length
        : 0,
      hackerai_composer_change_untrusted_count: recent.filter(
        (change) => change.trusted === false,
      ).length,
      hackerai_composer_change_composing_count: recent.filter(
        (change) => change.composing,
      ).length,
      ...(last
        ? {
            hackerai_composer_change_last_input_type: last.inputType,
            hackerai_composer_change_last_age:
              now - last.at < 100
                ? "lt_100ms"
                : now - last.at < 1000
                  ? "lt_1s"
                  : "lt_5s",
          }
        : {}),
    };
  } catch {
    return {};
  }
}
