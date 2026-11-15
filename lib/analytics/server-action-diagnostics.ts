import {
  captureQueuedAuthenticatedEvent,
  getIdentifiedAnalyticsUserId,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  classifyServerActionUnavailable,
  getServerActionBuildContext,
  SERVER_ACTION_ATTEMPT_COUNT_LIMIT,
  SERVER_ACTION_CLIENT_CONTEXT_EVENT,
  SERVER_ACTION_CLIENT_DIAGNOSTIC_VERSION,
  type ServerActionGlobalCaller,
  type ServerActionGlobalDecision,
  type ServerActionLocalCaller,
  type ServerActionUnavailableMatch,
} from "@/lib/analytics/server-action-privacy";

// Document-memory only. An owner change (sign-out, account switch, consent
// withdrawal or private page) starts a new epoch and clears all state.
const MAX_DEDUPE_ENTRIES = 16;
let subscribed = false;
let ownerEpoch = 0;
// undefined after an unreadable identity, so the next notification also resets.
let epochOwner: string | null | undefined = null;
let documentNonce: string | null = null;
const emitted = new Set<string>();
const counters = new Map<
  ServerActionLocalCaller,
  { settled: number; recognized: number; overflowed: boolean }
>();

type OwnerSnapshot = { owner: string; epoch: number };

function startNewEpoch(owner: string | null | undefined) {
  epochOwner = owner;
  ownerEpoch += 1;
  emitted.clear();
  counters.clear();
}

function ensureOwnerEpochSubscription() {
  if (subscribed) return;
  epochOwner = getPermittedAnalyticsUserId();
  subscribeAuthenticatedAnalytics(() => {
    let owner: string | null | undefined;
    try {
      owner = getPermittedAnalyticsUserId();
    } catch {
      owner = undefined;
    }
    // Identification of the same owner notifies too; only an owner change resets.
    if (owner !== undefined && owner === epochOwner) return;
    startNewEpoch(owner);
  });
  subscribed = true;
}

function currentIdentifiedOwner() {
  const owner = getPermittedAnalyticsUserId();
  return owner && getIdentifiedAnalyticsUserId() === owner ? owner : null;
}

function snapshotOwner(): OwnerSnapshot | null {
  ensureOwnerEpochSubscription();
  const epoch = ownerEpoch;
  const owner = currentIdentifiedOwner();
  return owner && ownerEpoch === epoch ? { owner, epoch } : null;
}

/** Recheck after any read that could synchronously change analytics identity. */
function isCurrent({ owner, epoch }: OwnerSnapshot) {
  return ownerEpoch === epoch && currentIdentifiedOwner() === owner;
}

function emit(
  expected: OwnerSnapshot,
  caller: ServerActionLocalCaller | ServerActionGlobalCaller,
  decision: "locally_handled_no_reload" | ServerActionGlobalDecision,
  match: ServerActionUnavailableMatch,
  denominator: Record<string, unknown>,
) {
  const build = getServerActionBuildContext();
  const dedupeKey = [
    caller,
    build.build_state === "measured"
      ? build.hackerai_frontend_build_commit
      : "unavailable",
    decision,
    expected.epoch,
  ].join(":");
  if (emitted.has(dedupeKey)) return;
  // Unique per document so the queue's deterministic UUID cannot merge reloads.
  documentNonce ??= globalThis.crypto?.randomUUID?.() ?? null;
  if (!documentNonce || !isCurrent(expected)) return;

  const accepted = captureQueuedAuthenticatedEvent({
    event: SERVER_ACTION_CLIENT_CONTEXT_EVENT,
    properties: {
      server_action_client_diagnostic_version:
        SERVER_ACTION_CLIENT_DIAGNOSTIC_VERSION,
      caller,
      ...match,
      recovery_decision: decision,
      ...build,
      ...denominator,
    },
    dedupeKey: `${documentNonce}:${dedupeKey}`,
  });
  if (!accepted || ownerEpoch !== expected.epoch) return;
  emitted.add(dedupeKey);
  if (emitted.size > MAX_DEDUPE_ENTRIES) {
    emitted.delete(emitted.values().next().value as string);
  }
}

/**
 * Snapshot the permitted, identified owner before a known caller awaits its
 * Server Action. Call the returned function once when the action settles,
 * passing the rejection reason on failure. It never throws.
 */
export function beginServerActionDiagnostic(
  caller: ServerActionLocalCaller,
): (error?: unknown) => void {
  let settled = false;
  try {
    const expected = snapshotOwner();
    if (!expected) return () => {};
    return (error?: unknown) => {
      if (settled) return;
      settled = true;
      try {
        // A late settlement must not attach to a different or re-entered owner.
        if (!isCurrent(expected)) return;
        const match = classifyServerActionUnavailable(error);
        if (!isCurrent(expected)) return;
        // The epoch is unchanged, so this counter belongs to the same owner.
        const counter = counters.get(caller) ?? {
          settled: 0,
          recognized: 0,
          overflowed: false,
        };
        counters.set(caller, counter);
        if (counter.settled >= SERVER_ACTION_ATTEMPT_COUNT_LIMIT) {
          counter.overflowed = true;
        } else {
          counter.settled += 1;
          if (match) counter.recognized += 1;
        }
        if (!match) return;
        emit(
          expected,
          caller,
          "locally_handled_no_reload",
          match,
          counter.overflowed
            ? { attempt_denominator_kind: "unmeasured" }
            : {
                attempt_denominator_kind: "caller_settled_prefix",
                caller_settled_attempt_count: counter.settled,
                caller_recognized_rejection_count: counter.recognized,
              },
        );
      } catch {
        // Optional diagnostics never change the caller's result or UI.
      }
    };
  } catch {
    return () => {};
  }
}

/**
 * Record the existing global recovery decision for a recognized unavailable
 * action. This describes the current consent/identity context, not the owner
 * of the unknown original action.
 */
export function recordGlobalServerActionDecision(
  caller: ServerActionGlobalCaller,
  error: unknown,
  decision: ServerActionGlobalDecision,
) {
  try {
    const expected = snapshotOwner();
    if (!expected) return;
    const match = classifyServerActionUnavailable(error);
    if (!match || !isCurrent(expected)) return;
    emit(expected, caller, decision, match, {
      attempt_denominator_kind: "unmeasured",
    });
  } catch {
    // Recovery proceeds unchanged.
  }
}
