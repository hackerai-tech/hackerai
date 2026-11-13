"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import { v4 as uuidv4 } from "uuid";
import {
  NEXT_ACTIONS_REASON_HEADER,
  isRetryableNextActionsConflict,
  nextActionsDeliveryReason,
  type NextActionsDeliveryReason,
  type NextActionsFailurePhase,
} from "@/lib/chat/next-actions/delivery";
import {
  NEXT_ACTIONS_VERSION,
  emptyNextActionsResponseSchema,
  nextActionsResponseSchema,
  type CompletedPredictionTurn,
  type NextActionsBatch,
} from "@/lib/chat/next-actions/contracts";

export type NextActionsController = {
  batch: NextActionsBatch | null;
  accept: (index: number, method: "keyboard" | "pointer") => boolean;
  dismiss: () => void;
  invalidate: () => void;
  exposed: () => void;
  recordTyping: () => void;
  prepareSubmission: () => (submitted: boolean) => void;
};

type Options = {
  userId?: string;
  chatId?: string;
  chatMode: "ask" | "agent";
  modeReady?: boolean;
  completedTurn?: CompletedPredictionTurn | null;
  interruptedTurn?: { chatId: string } | null;
  latestMessageId?: string;
  latestMessageIsAssistant?: boolean;
  status: string;
  // `blocked` revokes the current suggestion (consumed and deleted).
  // `suspended` only hides it: no new request starts, a sent request may
  // settle hidden, and the same batch returns once the condition clears.
  blocked: boolean;
  suspended?: boolean;
  input: string;
  getInput: () => string;
  setInput: (text: string) => void;
  hasAttachments: () => boolean;
};

// A consumed result cannot reappear after navigation/reconnect. Only opaque IDs
// are cached locally; prediction content is stored privately in Convex, never analytics.
const CONSUMED_KEY = "next-actions:consumed:v1";
function consumedKeys(): string[] {
  try {
    const value: unknown = JSON.parse(
      sessionStorage.getItem(CONSUMED_KEY) ?? "[]",
    );
    return Array.isArray(value)
      ? value
          .filter((key): key is string => typeof key === "string")
          .slice(-100)
      : [];
  } catch {
    return [];
  }
}
function consume(key: string) {
  try {
    sessionStorage.setItem(
      CONSUMED_KEY,
      JSON.stringify(
        [...consumedKeys().filter((item) => item !== key), key].slice(-100),
      ),
    );
  } catch {
    /* private browsing */
  }
}
function consumed(key: string) {
  return consumedKeys().includes(key);
}
function remember(set: Set<string>, key: string) {
  set.add(key);
  if (set.size > 100) set.delete(set.values().next().value!);
}

export function useNextActions(options: Options): NextActionsController {
  const current = useRef(options);
  useLayoutEffect(() => {
    current.current = options;
  });
  const [batch, setBatch] = useState<NextActionsBatch | null>(null);
  const batchRef = useRef<NextActionsBatch | null>(null);
  const request = useRef<AbortController | null>(null);
  const readiness = useRef<{ key: string; markTyped: () => void } | null>(null);
  const attempted = useRef(new Set<string>());
  const exposedIds = useRef(new Set<string>());
  const accepted = useRef<{
    batch: NextActionsBatch;
    index: number;
    text: string;
  } | null>(null);
  const pending = useRef<{
    batch: NextActionsBatch;
    index: number;
    submittedAt: number;
  } | null>(null);
  const submissionInProgress = useRef(false);
  const messageId = options.latestMessageId;
  const completedHere = Boolean(
    options.completedTurn?.chatId === options.chatId &&
    options.completedTurn?.messageId === messageId,
  );
  const key =
    options.userId &&
    options.chatId &&
    messageId &&
    (options.latestMessageIsAssistant || completedHere)
      ? `${options.userId}:${options.chatId}:${messageId}`
      : null;
  const keyRef = useRef(key);
  const previousMode = useRef(options.chatMode);
  const previousModeReady = useRef(options.modeReady !== false);
  const previousOwner = useRef(`${options.userId}:${options.chatId}`);
  useLayoutEffect(() => {
    if (keyRef.current !== key) {
      request.current?.abort();
      request.current = null;
      batchRef.current = null;

      setBatch(null);
    }
    keyRef.current = key;
  }, [key]);

  const capture = useCallback(
    (
      event: string,
      source: NextActionsBatch,
      extra: Record<string, string | number | boolean> = {},
    ) => {
      captureQueuedAuthenticatedEvent({
        event: `contextual_next_actions_${event}`,
        dedupeKey: `${source.batchId}:${event}`,
        properties: {
          definition_version: NEXT_ACTIONS_VERSION,
          batch_id: source.batchId,
          chat_id: current.current.chatId,
          message_id: source.messageId,
          mode: source.mode,
          presentation: "inline_composer",
          ...extra,
        },
      });
    },
    [current],
  );

  const invalidate = useCallback(() => {
    const alreadyConsumed = keyRef.current ? consumed(keyRef.current) : true;
    if (keyRef.current) {
      remember(attempted.current, keyRef.current);
      consume(keyRef.current);
    }
    const now = current.current;
    if (
      !alreadyConsumed &&
      keyRef.current &&
      now.chatId &&
      now.latestMessageId
    ) {
      void fetch("/api/chat/next-actions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chatId: now.chatId,
          messageId: now.latestMessageId,
        }),
        keepalive: true,
      }).catch(() => {});
    }
    request.current?.abort();
    batchRef.current = null;
    setBatch(null);
  }, [keyRef]);

  useLayoutEffect(() => {
    const owner = `${options.userId}:${options.chatId}`;
    const modeReady = options.modeReady !== false;
    if (
      previousOwner.current !== owner ||
      !modeReady ||
      !previousModeReady.current
    ) {
      previousModeReady.current = modeReady;
      previousOwner.current = owner;
      previousMode.current = options.chatMode;
      return;
    }
    if (previousMode.current === options.chatMode) return;
    previousMode.current = options.chatMode;
    // Revoke before paint, including a pending result that could otherwise
    // reappear after switching back. Keep any already accepted draft intact.

    invalidate();
  }, [
    options.chatMode,
    options.modeReady,
    options.userId,
    options.chatId,
    invalidate,
  ]);

  // Synchronous getters protect the gap between an input event and React commit.
  const canRetain = useCallback(() => {
    const now = current.current;
    return Boolean(
      keyRef.current &&
      !now.blocked &&
      now.modeReady !== false &&
      (!batchRef.current || batchRef.current.mode === now.chatMode) &&
      now.status === "ready" &&
      (!batchRef.current || batchRef.current.messageId === now.latestMessageId),
    );
  }, [current, keyRef]);
  const isSuspended = useCallback(
    () =>
      current.current.suspended === true || current.current.hasAttachments(),
    [current],
  );
  const canUse = useCallback(
    () => canRetain() && !isSuspended() && current.current.getInput() === "",
    [canRetain, isSuspended],
  );

  useEffect(() => {
    accepted.current = null;
    pending.current = null;
    attempted.current.clear();
    batchRef.current = null;

    setBatch(null);
    return () => request.current?.abort();
  }, [options.chatId, options.userId]);

  useEffect(() => {
    if (options.interruptedTurn?.chatId !== options.chatId) return;
    pending.current = null;
    accepted.current = null;
  }, [options.interruptedTurn, options.chatId]);

  // Draft edits do not cancel or consume a prediction. Ownership/completion
  // changes still cancel work, and its result never writes into the draft.
  useEffect(() => () => request.current?.abort(), [key, completedHere]);

  useEffect(() => {
    if (options.input && readiness.current?.key === key)
      readiness.current.markTyped();
    if (!options.input && !submissionInProgress.current)
      accepted.current = null;
    if (options.status === "error") pending.current = null;
    if (!key) return;
    if (!canRetain()) {
      if (batchRef.current || request.current) invalidate();
      return;
    }
    if (!canUse() || batchRef.current || request.current) return;
    const attemptKey = `${key}:${completedHere ? "generate" : "restore"}`;
    if (attempted.current.has(attemptKey) || consumed(key)) return;
    const controller = new AbortController();
    request.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const eligibleKey = key;
    const owner = {
      userId: options.userId,
      chatId: options.chatId,
      messageId: options.latestMessageId,
      mode: options.chatMode,
    };
    const requestKind = completedHere ? "generate" : "restore";
    const attemptId = uuidv4();
    const startedAt = performance.now();
    let sent = false;
    let settled = false;
    let timedOut = false;
    let typed = false;
    let httpAttempts = 0;
    let httpStatus: number | undefined;
    let serverReason: NextActionsDeliveryReason | undefined;
    let failurePhase: NextActionsFailurePhase = "network";
    const tracking = {
      key,
      markTyped: () => {
        typed = true;
      },
    };
    readiness.current = tracking;
    // Request kind describes the browser request, not proof of a model call.
    // Saved restores and empty/gated responses must not inflate generation spend.
    const report = (
      outcome: "ready" | "empty" | "failed" | "aborted" | "timeout",
      ready?: NextActionsBatch,
    ) => {
      if (settled) return;
      settled = true;
      if (readiness.current === tracking) readiness.current = null;
      if (!sent || current.current.userId !== owner.userId) return;
      const sameTurn =
        keyRef.current === eligibleKey &&
        current.current.chatMode === owner.mode;
      const typingNow =
        outcome === "aborted" || !sameTurn
          ? undefined
          : current.current.getInput() !== "";
      try {
        captureQueuedAuthenticatedEvent({
          event: "contextual_next_actions_settled",
          dedupeKey: attemptId,
          properties: {
            definition_version: NEXT_ACTIONS_VERSION,
            timing_version: 1,
            delivery_version: 1,
            attempt_id: attemptId,
            chat_id: owner.chatId,
            message_id: owner.messageId,
            mode: owner.mode,
            presentation: "inline_composer",
            request_kind: requestKind,
            outcome,
            http_attempts: httpAttempts,
            retry_count: Math.max(0, httpAttempts - 1),
            ...(httpStatus !== undefined && { http_status: httpStatus }),
            ...(serverReason && { server_reason: serverReason }),
            ...(["failed", "aborted", "timeout"].includes(outcome) && {
              failure_phase:
                outcome === "timeout"
                  ? "deadline"
                  : outcome === "aborted"
                    ? "lifecycle"
                    : failurePhase,
            }),
            elapsed_ms: Math.max(0, Math.round(performance.now() - startedAt)),
            typed_before_settle: typed || typingNow === true,
            page_visible: document.visibilityState === "visible",
            ...(typingNow !== undefined && {
              draft_nonempty_at_settle: typingNow,
            }),
            ...(ready && {
              batch_id: ready.batchId,
              suggestion_count: ready.suggestions.length,
            }),
          },
        });
      } catch {
        /* Optional telemetry must never suppress a valid suggestion. */
      }
    };
    const run = async (attempt = 0) => {
      try {
        if (
          controller.signal.aborted ||
          keyRef.current !== eligibleKey ||
          !canRetain()
        ) {
          report("aborted");
          return;
        }
        if (!sent && isSuspended()) {
          // Defer an unsent request without marking it attempted, so the same
          // source can start once the temporary condition clears.
          controller.abort();
          return;
        }
        remember(attempted.current, attemptKey);
        httpAttempts++;
        httpStatus = undefined;
        serverReason = undefined;
        failurePhase = "network";
        sent = true;
        const response = await fetch("/api/chat/next-actions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chatId: current.current.chatId,
            messageId: current.current.latestMessageId,
            restoreOnly: !completedHere,
          }),
          signal: controller.signal,
        });
        failurePhase = "http";
        if (
          Number.isInteger(response.status) &&
          response.status >= 100 &&
          response.status <= 599
        )
          httpStatus = response.status;
        // Optional diagnostic headers must never turn a valid response into failure.
        try {
          serverReason = nextActionsDeliveryReason(
            response.headers?.get(NEXT_ACTIONS_REASON_HEADER),
          );
        } catch {
          /* Ignore malformed optional metadata. */
        }
        if (
          response.status === 409 &&
          isRetryableNextActionsConflict(serverReason) &&
          attempt < 3 &&
          !controller.signal.aborted
        ) {
          timer = setTimeout(() => void run(attempt + 1), 1_000);
          return;
        }
        if (!response.ok) {
          report("failed");
          return;
        }
        failurePhase = "decode";
        const data: unknown = await response.json();
        failurePhase = "schema";
        if (emptyNextActionsResponseSchema.safeParse(data).success) {
          report("empty");
          return;
        }
        const parsed = nextActionsResponseSchema.safeParse(data);
        if (!parsed.success) {
          report("failed");
          return;
        }
        if (!parsed.data.suggestions.length) {
          report("empty");
          return;
        }
        if (
          parsed.data.mode !== current.current.chatMode ||
          controller.signal.aborted ||
          keyRef.current !== eligibleKey ||
          !canRetain() ||
          consumed(eligibleKey) ||
          parsed.data.messageId !== current.current.latestMessageId
        ) {
          report("aborted");
          return;
        }
        report("ready", parsed.data);
        batchRef.current = parsed.data;
        setBatch(parsed.data);
      } catch {
        report("failed");
        /* Optional predictions are silent on timeout/network/abort. */
      }
    };
    timer = setTimeout(() => void run(), 500);
    const deadline = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 18_000);
    controller.signal.addEventListener(
      "abort",
      () => {
        report(timedOut ? "timeout" : "aborted");
        clearTimeout(timer);
        clearTimeout(deadline);
        if (request.current === controller) request.current = null;
      },
      { once: true },
    );
  }, [
    key,
    completedHere,
    options.status,
    options.chatMode,
    options.modeReady,
    options.blocked,
    options.suspended,
    options.input,
    options.latestMessageId,
    canUse,
    canRetain,
    isSuspended,
    invalidate,
    current,
    keyRef,
  ]);

  useEffect(() => {
    const followup = pending.current;
    if (
      !followup ||
      !options.completedTurn ||
      options.completedTurn.messageId === followup.batch.messageId
    )
      return;
    pending.current = null;
    if (Date.now() - followup.submittedAt <= 30 * 60_000) {
      // Browser completion is diagnostic. The authoritative natural-completion
      // guardrail remains the existing server chat completion event/finish reason.
      capture("followup_finished", followup.batch, {
        suggestion_index: followup.index,
        followup_message_id: options.completedTurn.messageId,
      });
    }
  }, [options.completedTurn, capture]);

  const visible =
    batch &&
    options.status === "ready" &&
    !options.blocked &&
    !options.suspended &&
    options.modeReady !== false &&
    batch.mode === options.chatMode &&
    options.input === "" &&
    batch.messageId === options.latestMessageId
      ? batch
      : null;
  return {
    batch: visible,
    recordTyping: () => {
      if (readiness.current?.key === keyRef.current)
        readiness.current.markTyped();
    },
    invalidate,
    dismiss: () => {
      if (batchRef.current) capture("dismissed", batchRef.current);
      invalidate();
    },
    exposed: () => {
      const source = batchRef.current;
      if (!source || !canUse() || exposedIds.current.has(source.batchId))
        return;
      remember(exposedIds.current, source.batchId);
      capture("exposed", source, {
        suggestion_count: source.suggestions.length,
        shown_count: 1,
      });
    },
    accept: (index, method) => {
      const source = batchRef.current;
      // A hidden batch is kept for restoration, never accepted or consumed.
      if (isSuspended()) return false;
      if (!source || !canUse() || !source.suggestions[index]) {
        invalidate();
        return false;
      }
      const text = source.suggestions[index];
      accepted.current = { batch: source, index, text };
      capture("accepted", source, { suggestion_index: index, method });
      invalidate();
      current.current.setInput(text);
      return true;
    },
    prepareSubmission: () => {
      const selection = accepted.current;
      const text = current.current.getInput();
      submissionInProgress.current = true;
      invalidate();
      return (submitted) => {
        submissionInProgress.current = false;
        if (!submitted) return;
        pending.current = null;
        accepted.current = null;
        if (!selection || !text.trim()) return;
        capture("submitted", selection.batch, {
          suggestion_index: selection.index,
          edited: text !== selection.text,
        });
        pending.current = { ...selection, submittedAt: Date.now() };
      };
    },
  };
}
