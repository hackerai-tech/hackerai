import { AGENT_RUN_SPEND_CAP_FINISH_REASON } from "@/lib/chat/agent-run-spend-cap";
import { LOCAL_CONNECTION_LOST_FINISH_REASON } from "@/lib/chat/local-connection-stop";
import {
  BUDGET_EXHAUSTION_FINISH_REASON,
  CLIENT_SAVED_FINISH_REASON,
  DOOM_LOOP_FINISH_REASON,
  OUTPUT_LIMIT_FINISH_REASON,
  POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
  PREEMPTIVE_TIMEOUT_FINISH_REASON,
  STEP_LIMIT_FINISH_REASON,
  TOKEN_EXHAUSTION_FINISH_REASON,
} from "@/lib/chat/stop-conditions";
import {
  getChatStarterById,
  type ChatStarterId,
  type ChatStarterPresentation,
} from "@/lib/chat/starter-prompts";

/**
 * Attribution from a chat starter selection to the outgoing user message and
 * that turn's persisted terminal state. Only opaque IDs, fixed categories and
 * timestamps are stored or sent; never prompts, drafts or error text.
 */

export const CHAT_STARTER_EVENTS = {
  selected: "chat_starter_selected",
  submitted: "chat_starter_submitted",
  notHandedOff: "chat_starter_submit_not_handed_off",
  outcome: "chat_starter_turn_outcome",
  discarded: "chat_starter_selection_discarded",
} as const;

export type StarterMode = "ask" | "agent";

export type StarterSelection = {
  selectionId: string;
  exampleId: ChatStarterId;
  definitionVersion: number;
  mode: StarterMode;
  presentation: ChatStarterPresentation;
  draftId: string;
  selectedAt: number;
};

export type StarterAttribution = StarterSelection &
  (
    | { state: "selected" }
    | {
        state: "submitted";
        chatId: string;
        userMessageId: string;
        submittedAt: number;
      }
  );

type SubmittedAttribution = Extract<StarterAttribution, { state: "submitted" }>;

type StoredAttributions = {
  version: 1;
  userId: string;
  entries: StarterAttribution[];
  /** Selection IDs that already ended; they are never revived. */
  finished: string[];
};

export const ATTRIBUTION_STORAGE_KEY = "hackerai:chat-starters:attribution:v1";
/** A selection or pending turn older than this is abandoned, not attributed. */
export const ATTRIBUTION_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20;
const MAX_FINISHED = 50;
/** Server and browser clocks can disagree; only reject clearly older runs. */
const RUN_CLOCK_SKEW_MS = 10 * 60 * 1000;

// Opaque client/server identifiers only: UUIDs, Convex-style IDs and similar.
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
export const isOpaqueId = (value: unknown): value is string =>
  typeof value === "string" && OPAQUE_ID.test(value);

export const boundedElapsedMs = (from: number, to: number) =>
  Math.min(ATTRIBUTION_TTL_MS, Math.max(0, Math.round(to - from)));

const isStarterMode = (value: unknown): value is StarterMode =>
  value === "ask" || value === "agent";
const isPresentation = (value: unknown): value is ChatStarterPresentation =>
  value === "expanded" || value === "collapsed";
const isTimestamp = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

function parseEntry(value: unknown): StarterAttribution | null {
  if (!value || typeof value !== "object") return null;
  const entry = value as Record<string, unknown>;
  if (
    !isOpaqueId(entry.selectionId) ||
    typeof entry.exampleId !== "string" ||
    !getChatStarterById(entry.exampleId) ||
    !Number.isInteger(entry.definitionVersion) ||
    !isStarterMode(entry.mode) ||
    !isPresentation(entry.presentation) ||
    typeof entry.draftId !== "string" ||
    entry.draftId.length === 0 ||
    entry.draftId.length > 128 ||
    !isTimestamp(entry.selectedAt)
  )
    return null;
  const selection: StarterSelection = {
    selectionId: entry.selectionId,
    exampleId: entry.exampleId as ChatStarterId,
    definitionVersion: entry.definitionVersion as number,
    mode: entry.mode,
    presentation: entry.presentation,
    draftId: entry.draftId,
    selectedAt: entry.selectedAt,
  };
  if (entry.state === "selected") return { ...selection, state: "selected" };
  if (
    entry.state === "submitted" &&
    isOpaqueId(entry.chatId) &&
    isOpaqueId(entry.userMessageId) &&
    isTimestamp(entry.submittedAt)
  )
    return {
      ...selection,
      state: "submitted",
      chatId: entry.chatId,
      userMessageId: entry.userMessageId,
      submittedAt: entry.submittedAt,
    };
  return null;
}

const entryStartedAt = (entry: StarterAttribution) =>
  entry.state === "submitted" ? entry.submittedAt : entry.selectedAt;

/**
 * Account-owned, tab-scoped store. Another account's data reads as empty and
 * is replaced on the next write.
 */
export function readAttributions(
  userId: string,
  now = Date.now(),
): StoredAttributions {
  const empty: StoredAttributions = {
    version: 1,
    userId,
    entries: [],
    finished: [],
  };
  try {
    const raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return empty;
    const parsed = JSON.parse(raw) as Partial<StoredAttributions> | null;
    if (parsed?.version !== 1 || parsed.userId !== userId) return empty;
    const finished = Array.isArray(parsed.finished)
      ? parsed.finished.filter(isOpaqueId).slice(-MAX_FINISHED)
      : [];
    const entries = (Array.isArray(parsed.entries) ? parsed.entries : [])
      .map(parseEntry)
      .filter(
        (entry): entry is StarterAttribution =>
          entry !== null &&
          !finished.includes(entry.selectionId) &&
          now - entryStartedAt(entry) <= ATTRIBUTION_TTL_MS,
      )
      .slice(-MAX_ENTRIES);
    return { version: 1, userId, entries, finished };
  } catch {
    return empty;
  }
}

function writeAttributions(store: StoredAttributions) {
  try {
    window.sessionStorage.setItem(
      ATTRIBUTION_STORAGE_KEY,
      JSON.stringify({
        ...store,
        entries: store.entries.slice(-MAX_ENTRIES),
        finished: store.finished.slice(-MAX_FINISHED),
      }),
    );
  } catch {
    // Attribution is optional; storage can be unavailable or full.
  }
}

export function clearAttributions() {
  try {
    window.sessionStorage.removeItem(ATTRIBUTION_STORAGE_KEY);
  } catch {
    // Nothing to clear when storage is unavailable.
  }
}

export function clearAttributionsOfOtherUsers(userId: string) {
  try {
    const raw = window.sessionStorage.getItem(ATTRIBUTION_STORAGE_KEY);
    if (!raw) return;
    const owner = (JSON.parse(raw) as { userId?: unknown } | null)?.userId;
    if (owner !== userId) clearAttributions();
  } catch {
    clearAttributions();
  }
}

/** Insert or replace an entry, unless it already ended. */
export function saveAttribution(userId: string, entry: StarterAttribution) {
  const store = readAttributions(userId);
  if (store.finished.includes(entry.selectionId)) return false;
  writeAttributions({
    ...store,
    entries: [
      ...store.entries.filter((item) => item.selectionId !== entry.selectionId),
      entry,
    ],
  });
  return true;
}

export function finishAttribution(userId: string, selectionId: string) {
  const store = readAttributions(userId);
  writeAttributions({
    ...store,
    entries: store.entries.filter((item) => item.selectionId !== selectionId),
    finished: [
      ...store.finished.filter((id) => id !== selectionId),
      selectionId,
    ],
  });
}

/** The newest unsubmitted selection that filled this draft. */
export function findSelectionForDraft(
  userId: string,
  draftId: string,
): Extract<StarterAttribution, { state: "selected" }> | undefined {
  return readAttributions(userId)
    .entries.filter(
      (entry): entry is Extract<StarterAttribution, { state: "selected" }> =>
        entry.state === "selected" && entry.draftId === draftId,
    )
    .at(-1);
}

export function findSubmittedForChat(userId: string, chatId: string) {
  return readAttributions(userId).entries.filter(
    (entry): entry is SubmittedAttribution =>
      entry.state === "submitted" && entry.chatId === chatId,
  );
}

export type StarterTurnOutcome =
  | "completed"
  | "canceled"
  | "failed"
  | "incomplete"
  /** Ended, but persisted state does not say how. */
  | "unknown";

/** Fixed categories; raw or unknown finish reasons are never forwarded. */
export type StarterTerminalReason =
  | "stop"
  | "user_stop"
  | "no_finish_reason"
  | "unrecognized_finish_reason"
  | "error"
  | "content_filter"
  | "connection_lost"
  | "run_crashed"
  | "loop_detected"
  | "output_limit"
  | "context_limit"
  | "step_limit"
  | "usage_limit"
  | "timeout"
  | "summarization_incomplete";

const TERMINAL_REASONS = new Map<
  string,
  { outcome: StarterTurnOutcome; reason: StarterTerminalReason }
>([
  ["stop", { outcome: "completed", reason: "stop" }],
  ["error", { outcome: "failed", reason: "error" }],
  ["content-filter", { outcome: "failed", reason: "content_filter" }],
  [
    LOCAL_CONNECTION_LOST_FINISH_REASON,
    { outcome: "failed", reason: "connection_lost" },
  ],
  [CLIENT_SAVED_FINISH_REASON, { outcome: "failed", reason: "run_crashed" }],
  [DOOM_LOOP_FINISH_REASON, { outcome: "failed", reason: "loop_detected" }],
  [
    OUTPUT_LIMIT_FINISH_REASON,
    { outcome: "incomplete", reason: "output_limit" },
  ],
  [
    TOKEN_EXHAUSTION_FINISH_REASON,
    { outcome: "incomplete", reason: "context_limit" },
  ],
  [STEP_LIMIT_FINISH_REASON, { outcome: "incomplete", reason: "step_limit" }],
  ["tool-calls", { outcome: "incomplete", reason: "step_limit" }],
  [
    BUDGET_EXHAUSTION_FINISH_REASON,
    { outcome: "incomplete", reason: "usage_limit" },
  ],
  [
    AGENT_RUN_SPEND_CAP_FINISH_REASON,
    { outcome: "incomplete", reason: "usage_limit" },
  ],
  ["timeout", { outcome: "incomplete", reason: "timeout" }],
  [
    PREEMPTIVE_TIMEOUT_FINISH_REASON,
    { outcome: "incomplete", reason: "timeout" },
  ],
  [
    POST_SUMMARIZATION_INCOMPLETE_FINISH_REASON,
    { outcome: "incomplete", reason: "summarization_incomplete" },
  ],
]);

/**
 * Persisted chat state only. Stop records `canceled_at` and clears the finish
 * reason, but later cleanup can clear `canceled_at` too; a missing reason is
 * therefore "unknown" unless the cancellation itself is still visible.
 * "completed" is a technical completion proxy, not a usefulness judgement.
 */
export function classifyTerminalState(
  finishReason: string | undefined,
  canceled: boolean,
): { outcome: StarterTurnOutcome; reason: StarterTerminalReason } {
  if (canceled) return { outcome: "canceled", reason: "user_stop" };
  if (finishReason === undefined || finishReason === "")
    return { outcome: "unknown", reason: "no_finish_reason" };
  return (
    TERMINAL_REASONS.get(finishReason) ?? {
      outcome: "unknown",
      reason: "unrecognized_finish_reason",
    }
  );
}

/** Minimal view of the current chat's persisted state, built by the parent. */
export type StarterPersistedTurn = {
  chatId: string;
  /** No stream, run, approval or wait is active; the chat finished a turn. */
  settled: boolean;
  finishReason?: string;
  lastRunFinishedAt?: number;
  /** Set by Stop; may be cleared again by later stream cleanup. */
  canceledAt?: number;
  /** Loaded persisted user message IDs, oldest first. */
  userMessageIds: readonly string[];
  /** Latest persisted assistant message after the latest user message. */
  replyAssistantMessageId?: string;
};

type ChatStateForTurn = {
  id?: unknown;
  finish_reason?: string;
  last_run_finished_at?: number;
  canceled_at?: number;
  active_stream_id?: unknown;
  active_trigger_run_id?: unknown;
  active_agent_approval_pending?: unknown;
  active_agent_user_wait?: unknown;
  deletion_started_at?: unknown;
};

/** Derive the snapshot from existing subscriptions; returns IDs only. */
export function getStarterPersistedTurn(
  chatId: string,
  chat: ChatStateForTurn | null | undefined,
  messages: readonly { id: string; role: string }[],
): StarterPersistedTurn | null {
  if (!chat || chat.id !== chatId || chat.deletion_started_at) return null;
  const userMessageIds = messages
    .filter((message) => message.role === "user")
    .map((message) => message.id);
  const latestUserIndex = messages.findLastIndex(
    (message) => message.role === "user",
  );
  const reply =
    latestUserIndex >= 0
      ? messages
          .slice(latestUserIndex + 1)
          .findLast((message) => message.role === "assistant")
      : undefined;
  return {
    chatId,
    settled:
      !chat.active_stream_id &&
      !chat.active_trigger_run_id &&
      !chat.active_agent_approval_pending &&
      !chat.active_agent_user_wait,
    finishReason: chat.finish_reason,
    lastRunFinishedAt: chat.last_run_finished_at,
    canceledAt: chat.canceled_at,
    userMessageIds,
    replyAssistantMessageId: reply?.id,
  };
}

export type ResolvedStarterTurn =
  | { status: "pending" }
  | { status: "superseded" }
  | {
      status: "terminal";
      /** Absent when a stop or failure ended the turn before a reply saved. */
      assistantMessageId?: string;
      outcome: StarterTurnOutcome;
      reason: StarterTerminalReason;
    };

/**
 * Match a submitted starter turn to persisted state. Only the turn whose user
 * message is the latest persisted one, with no active or waiting work and a
 * finish or cancellation time after this submission, is terminal. Completion
 * also needs the persisted reply. A later user turn means the outcome is no
 * longer observable from chat state.
 */
export function resolveStarterTurn(
  entry: SubmittedAttribution,
  turn: StarterPersistedTurn | null | undefined,
): ResolvedStarterTurn {
  if (!turn || turn.chatId !== entry.chatId) return { status: "pending" };
  const index = turn.userMessageIds.indexOf(entry.userMessageId);
  if (index < 0) return { status: "pending" };
  if (index < turn.userMessageIds.length - 1) return { status: "superseded" };
  if (!turn.settled) return { status: "pending" };
  // An earlier run's timestamps, or none at all, say nothing about this turn.
  const afterSubmission = (time: number | undefined): time is number =>
    isTimestamp(time) && time >= entry.submittedAt - RUN_CLOCK_SKEW_MS;
  const canceled = afterSubmission(turn.canceledAt);
  if (!canceled && !afterSubmission(turn.lastRunFinishedAt))
    return { status: "pending" };
  const classified = classifyTerminalState(turn.finishReason, canceled);
  const assistantMessageId = isOpaqueId(turn.replyAssistantMessageId)
    ? turn.replyAssistantMessageId
    : undefined;
  if (classified.outcome === "completed" && !assistantMessageId)
    return { status: "pending" };
  return {
    status: "terminal",
    ...(assistantMessageId ? { assistantMessageId } : {}),
    ...classified,
  };
}

const selectionProperties = (selection: StarterSelection) => ({
  selection_id: selection.selectionId,
  definition_version: selection.definitionVersion,
  example_id: selection.exampleId,
  mode: selection.mode,
  presentation: selection.presentation,
});

export function selectedEvent(selection: StarterSelection) {
  return {
    event: CHAT_STARTER_EVENTS.selected,
    dedupeKey: selection.selectionId,
    properties: selectionProperties(selection),
  };
}

export function submittedEvent(
  entry: SubmittedAttribution,
  attemptId: string,
  edited: boolean,
) {
  return {
    event: CHAT_STARTER_EVENTS.submitted,
    dedupeKey: `${entry.selectionId}:submitted`,
    properties: {
      ...selectionProperties(entry),
      attempt_id: attemptId,
      chat_id: entry.chatId,
      user_message_id: entry.userMessageId,
      edited,
      selection_to_submission_ms: boundedElapsedMs(
        entry.selectedAt,
        entry.submittedAt,
      ),
      // The browser handed this message to the chat transport. Persistence
      // and admission are established only by the outcome event.
      submission_source: "client_transport_handoff",
    },
  };
}

/**
 * A submit attempt the browser did not hand to the chat transport: the
 * handler refused it or threw. This is client-side only; server admission
 * failures after handoff surface through the outcome, never here.
 */
export function notHandedOffEvent(
  selection: StarterSelection,
  attemptId: string,
  reason: "client_refused" | "client_error",
  now = Date.now(),
) {
  return {
    event: CHAT_STARTER_EVENTS.notHandedOff,
    dedupeKey: `${attemptId}:not_handed_off`,
    properties: {
      ...selectionProperties(selection),
      attempt_id: attemptId,
      reason,
      selection_to_attempt_ms: boundedElapsedMs(selection.selectedAt, now),
    },
  };
}

export function outcomeEvent(
  entry: SubmittedAttribution,
  resolved: Extract<ResolvedStarterTurn, { status: "terminal" }>,
  now = Date.now(),
) {
  return {
    event: CHAT_STARTER_EVENTS.outcome,
    dedupeKey: `${entry.selectionId}:outcome`,
    properties: {
      ...selectionProperties(entry),
      chat_id: entry.chatId,
      user_message_id: entry.userMessageId,
      ...(resolved.assistantMessageId
        ? { assistant_message_id: resolved.assistantMessageId }
        : {}),
      outcome: resolved.outcome,
      terminal_reason: resolved.reason,
      outcome_source: "persisted_chat_state",
      // When this browser first saw the terminal state, including time the
      // chat was not open. Not model, provider or run duration.
      submission_to_observation_ms: boundedElapsedMs(entry.submittedAt, now),
    },
  };
}

export type StarterDiscardReason =
  "draft_cleared" | "mode_changed" | "ineligible_submission";

export function discardedEvent(
  selection: StarterSelection,
  reason: StarterDiscardReason,
  now = Date.now(),
) {
  return {
    event: CHAT_STARTER_EVENTS.discarded,
    dedupeKey: `${selection.selectionId}:discarded`,
    properties: {
      ...selectionProperties(selection),
      reason,
      selection_to_discard_ms: boundedElapsedMs(selection.selectedAt, now),
    },
  };
}

/** Whether the submitted text differs from the unedited example prompt. */
export function isEditedStarterText(exampleId: ChatStarterId, text: string) {
  return getChatStarterById(exampleId)?.prompt.trim() !== text.trim();
}
