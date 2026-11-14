import {
  getIdentifiedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";

const PHASES = ["replace_whitespace", "trim_whitespace"] as const;
const INPUT_SHAPES = ["string", "other"] as const;
const LENGTH_BUCKETS = [
  "empty",
  "le255",
  "le4095",
  "le65535",
  "le1048575",
  "ge1048576",
  "unknown",
] as const;

export type MessageNavigatorNormalizationPhase = (typeof PHASES)[number];
export type MessageNavigatorInputShape = (typeof INPUT_SHAPES)[number];
export type MessageNavigatorLengthBucket = (typeof LENGTH_BUCKETS)[number];

type Observation = {
  owner: string;
  phase: MessageNavigatorNormalizationPhase;
  inputShape: MessageNavigatorInputShape;
  lengthBucket: MessageNavigatorLengthBucket;
  at: number;
};

let subscribed = false;
let recent: Observation | undefined;

/** Coarse UTF-16 length; never an exact size. */
export function getMessageNavigatorLengthBucket(
  length: number,
): MessageNavigatorLengthBucket {
  if (!Number.isSafeInteger(length) || length < 0) return "unknown";
  if (length === 0) return "empty";
  if (length <= 255) return "le255";
  if (length <= 4095) return "le4095";
  if (length <= 65535) return "le65535";
  return length <= 1048575 ? "le1048575" : "ge1048576";
}

const isValid = (
  phase: unknown,
  inputShape: unknown,
  lengthBucket: unknown,
): boolean =>
  PHASES.includes(phase as MessageNavigatorNormalizationPhase) &&
  INPUT_SHAPES.includes(inputShape as MessageNavigatorInputShape) &&
  LENGTH_BUCKETS.includes(lengthBucket as MessageNavigatorLengthBucket) &&
  // Only a string input has a measured length.
  (inputShape === "string") === (lengthBucket !== "unknown");

/** Clear on a committed owner, consent or private-route transition. */
export function clearMessageNavigatorDiagnostics() {
  recent = undefined;
}

/** Retain only the last closed failure facts after identification; never the text or error. */
export function recordMessageNavigatorNormalizationFailure(
  phase: MessageNavigatorNormalizationPhase,
  inputShape: MessageNavigatorInputShape,
  lengthBucket: MessageNavigatorLengthBucket,
) {
  try {
    if (!subscribed) {
      subscribeAuthenticatedAnalytics(clearMessageNavigatorDiagnostics);
      subscribed = true;
    }
    recent = undefined;
    const owner = getIdentifiedAnalyticsUserId();
    if (!owner || !isValid(phase, inputShape, lengthBucket)) return;
    const at = performance.now();
    if (!Number.isFinite(at) || at < 0) return;
    recent = { owner, phase, inputShape, lengthBucket, at };
  } catch {
    recent = undefined;
    // Diagnostic state cannot interrupt rendering or replace its exception.
  }
}

/**
 * Nearby capture-time context, not proof the navigator threw the captured
 * exception. `committedOwner` is the provider's current committed analytics
 * owner; null or any mismatch discards the observation.
 */
export function getRecentMessageNavigatorDiagnostics(
  committedOwner: string | null,
): Record<string, string | number> {
  try {
    const owner = getIdentifiedAnalyticsUserId();
    const observation = recent;
    if (
      !observation ||
      typeof committedOwner !== "string" ||
      !committedOwner ||
      owner !== committedOwner ||
      observation.owner !== owner ||
      !isValid(
        observation.phase,
        observation.inputShape,
        observation.lengthBucket,
      )
    ) {
      recent = undefined;
      return {};
    }
    const age = performance.now() - observation.at;
    if (!Number.isFinite(age) || age < 0 || age >= 5000) {
      recent = undefined;
      return {};
    }
    return {
      hackerai_recent_navigator_version: 1,
      hackerai_recent_navigator_phase: observation.phase,
      hackerai_recent_navigator_input_shape: observation.inputShape,
      hackerai_recent_navigator_length_bucket: observation.lengthBucket,
      hackerai_recent_navigator_age:
        age < 100 ? "lt_100ms" : age < 1000 ? "lt_1s" : "lt_5s",
      hackerai_recent_navigator_association: "nearby_only",
    };
  } catch {
    recent = undefined;
    return {};
  }
}
