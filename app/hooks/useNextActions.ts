"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { captureQueuedAuthenticatedEvent } from "@/lib/analytics/client";
import {
  NEXT_ACTIONS_VERSION,
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
  prepareSubmission: () => (submitted: boolean) => void;
};

type Options = {
  userId?: string;
  chatId?: string;
  chatMode: "ask" | "agent";
  completedTurn?: CompletedPredictionTurn | null;
  interruptedTurn?: { chatId: string } | null;
  latestMessageId?: string;
  latestMessageIsAssistant?: boolean;
  status: string;
  blocked: boolean;
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
  const previousOwner = useRef(`${options.userId}:${options.chatId}`);
  useLayoutEffect(() => {
    if (keyRef.current !== key) {
      request.current?.abort();
      request.current = null;
      batchRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Revoke the previous message before accepting a new chat/message identity.
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
    if (previousOwner.current !== owner) {
      previousOwner.current = owner;
      previousMode.current = options.chatMode;
      return;
    }
    if (previousMode.current === options.chatMode) return;
    previousMode.current = options.chatMode;
    // Revoke before paint, including a pending result that could otherwise
    // reappear after switching back. Keep any already accepted draft intact.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Mode changes must abort and discard externally generated predictions before interaction.
    invalidate();
  }, [options.chatMode, options.userId, options.chatId, invalidate]);

  // Synchronous getters protect the gap between an input event and React commit.
  const canUse = useCallback(() => {
    const now = current.current;
    return Boolean(
      keyRef.current &&
      !now.blocked &&
      (!batchRef.current || batchRef.current.mode === now.chatMode) &&
      now.status === "ready" &&
      (!batchRef.current ||
        batchRef.current.messageId === now.latestMessageId) &&
      now.getInput() === "" &&
      !now.hasAttachments(),
    );
  }, [current, keyRef]);

  useEffect(() => {
    accepted.current = null;
    pending.current = null;
    attempted.current.clear();
    batchRef.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Navigation must discard async results before another chat can display them.
    setBatch(null);
    return () => request.current?.abort();
  }, [options.chatId, options.userId]);

  useEffect(() => {
    if (options.interruptedTurn?.chatId !== options.chatId) return;
    pending.current = null;
    accepted.current = null;
  }, [options.interruptedTurn, options.chatId]);

  useEffect(() => {
    if (!options.input && !submissionInProgress.current)
      accepted.current = null;
    if (options.status === "error") pending.current = null;
    if (!key) return;
    if (!canUse()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- Lifecycle changes revoke an already visible async prediction.
      if (batchRef.current || request.current) invalidate();
      return;
    }
    const attemptKey = `${key}:${completedHere ? "generate" : "restore"}`;
    if (attempted.current.has(attemptKey) || consumed(key)) return;
    const controller = new AbortController();
    request.current = controller;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const eligibleKey = key;
    const run = async (attempt = 0) => {
      try {
        if (
          controller.signal.aborted ||
          keyRef.current !== eligibleKey ||
          !canUse()
        )
          return;
        remember(attempted.current, attemptKey);
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
        if (
          response.status === 409 &&
          attempt < 3 &&
          !controller.signal.aborted
        ) {
          timer = setTimeout(() => void run(attempt + 1), 1_000);
          return;
        }
        if (!response.ok) return;
        const parsed = nextActionsResponseSchema.safeParse(
          await response.json(),
        );
        if (
          !parsed.success ||
          !parsed.data.suggestions.length ||
          parsed.data.mode !== current.current.chatMode ||
          controller.signal.aborted ||
          keyRef.current !== eligibleKey ||
          !canUse() ||
          consumed(eligibleKey) ||
          parsed.data.messageId !== current.current.latestMessageId
        )
          return;
        batchRef.current = parsed.data;
        setBatch(parsed.data);
      } catch {
        /* Optional predictions are silent on timeout/network/abort. */
      }
    };
    timer = setTimeout(() => void run(), 500);
    const deadline = setTimeout(() => controller.abort(), 18_000);
    return () => {
      clearTimeout(timer);
      clearTimeout(deadline);
      controller.abort();
      if (request.current === controller) request.current = null;
    };
  }, [
    key,
    completedHere,
    options.status,
    options.chatMode,
    options.blocked,
    options.input,
    options.latestMessageId,
    canUse,
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
    batch.mode === options.chatMode &&
    options.input === "" &&
    batch.messageId === options.latestMessageId
      ? batch
      : null;
  return {
    batch: visible,
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
