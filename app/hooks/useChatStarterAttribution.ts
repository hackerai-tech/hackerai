import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";
import {
  captureQueuedAuthenticatedEvent,
  getPermittedAnalyticsUserId,
  subscribeAuthenticatedAnalytics,
} from "@/lib/analytics/client";
import {
  clearAttributions,
  clearAttributionsOfOtherUsers,
  discardedEvent,
  findSelectionForDraft,
  findSubmittedForChat,
  finishAttribution,
  isEditedStarterText,
  notHandedOffEvent,
  outcomeEvent,
  resolveStarterTurn,
  saveAttribution,
  selectedEvent,
  submittedEvent,
  type StarterDiscardReason,
  type StarterMode,
  type StarterPersistedTurn,
  type StarterSelection,
} from "@/lib/analytics/chat-starters";
import {
  CHAT_STARTERS_DEFINITION_VERSION,
  type ChatStarter,
  type ChatStarterPresentation,
} from "@/lib/chat/starter-prompts";
import type { SubmitAttribution } from "@/app/hooks/useChatHandlers";

type Options = {
  userId: string | undefined;
  draftId: string;
  chatMode: StarterMode;
  /** Rendered composer value and its synchronous getter. */
  input: string;
  getInput: () => string;
  /** The current chat's persisted turn, derived from existing subscriptions. */
  persistedTurn: StarterPersistedTurn | null | undefined;
};

/** How the client submit handler resolved this attempt. */
export type StarterSubmitResult = "accepted" | "refused" | "error";

export type StarterSubmission = {
  /** Fourth `onSubmit` argument; undefined when this send is not attributed. */
  attribution: SubmitAttribution | undefined;
  settle: (result: StarterSubmitResult) => void;
};

const NO_SUBMISSION: StarterSubmission = {
  attribution: undefined,
  settle: () => {},
};

/** Optional analytics must never change the composer or a send. */
const safely = <T>(action: () => T, fallback: T): T => {
  try {
    return action();
  } catch {
    return fallback;
  }
};

/**
 * Run analytics work only while consent permits exactly this account. Async
 * settles can outlive an account or consent change; the queued capture helper
 * and the tab store would otherwise attribute that work to the new owner.
 * The check and the work run synchronously, so nothing can change between.
 */
const asOwner = (owner: string | undefined, work: (owner: string) => void) => {
  if (!owner) return;
  safely(() => {
    if (getPermittedAnalyticsUserId() === owner) work(owner);
  }, undefined);
};

const capture = (
  event: Parameters<typeof captureQueuedAuthenticatedEvent>[0],
) => safely(() => captureQueuedAuthenticatedEvent(event), false);

const discard = (
  owner: string | undefined,
  selection: StarterSelection,
  reason: StarterDiscardReason,
) =>
  asOwner(owner, (id) => {
    finishAttribution(id, selection.selectionId);
    capture(discardedEvent(selection, reason));
  });

/**
 * Links one starter selection to the actual outgoing user message and that
 * turn's persisted terminal state. State is tab-scoped, account-owned and
 * content-free, so a reload resumes attribution without storing the draft.
 */
export function useChatStarterAttribution({
  userId,
  draftId,
  chatMode,
  input,
  getInput,
  persistedTurn,
}: Options) {
  const submittingRef = useRef(false);
  const observedDraftRef = useRef({ draftId, nonEmpty: false });
  // Re-evaluate pending outcomes when analytics consent becomes available.
  const [analyticsOwner, setAnalyticsOwner] = useState(() =>
    safely(getPermittedAnalyticsUserId, null),
  );

  // Consent loss or an account change ends attribution for this tab. The
  // initial unresolved state is not a change and keeps reload recovery.
  useEffect(
    () =>
      safely(
        () =>
          subscribeAuthenticatedAnalytics(() => {
            const owner = safely(getPermittedAnalyticsUserId, null);
            setAnalyticsOwner(owner);
            if (!owner || owner !== userId)
              safely(clearAttributions, undefined);
          }),
        undefined,
      ),
    [userId],
  );
  useEffect(() => {
    // Another account's entries are never read; drop them on account change.
    if (userId) safely(() => clearAttributionsOfOtherUsers(userId), undefined);
  }, [userId]);

  const recordSelection = useCallback(
    (starter: ChatStarter, presentation: ChatStarterPresentation) =>
      asOwner(userId, (owner) => {
        const selection: StarterSelection = {
          selectionId: uuidv4(),
          exampleId: starter.id,
          definitionVersion: CHAT_STARTERS_DEFINITION_VERSION,
          mode: chatMode,
          presentation,
          draftId,
          selectedAt: Date.now(),
        };
        // Queued so a selection before SDK identification is not lost.
        if (!capture(selectedEvent(selection))) return;
        saveAttribution(owner, { ...selection, state: "selected" });
        // The filled draft is the selection; a later empty draft clears it.
        observedDraftRef.current = { draftId, nonEmpty: false };
      }),
    [chatMode, draftId, userId],
  );

  // Clearing the composer abandons the selection. Restores, chat switches and
  // accepted submissions are not clears: only an observed non-empty draft on
  // the same draft ID that the user empties counts.
  useEffect(() => {
    const observed = observedDraftRef.current;
    if (observed.draftId !== draftId) {
      observedDraftRef.current = { draftId, nonEmpty: false };
      return;
    }
    // Restoring a draft updates the composer in a layout effect; ignore the
    // stale value rendered before that restore.
    if (input !== safely(getInput, input)) return;
    if (input !== "") {
      observed.nonEmpty = true;
      return;
    }
    if (!observed.nonEmpty || submittingRef.current || !userId) return;
    observed.nonEmpty = false;
    const selection = safely(
      () => findSelectionForDraft(userId, draftId),
      undefined,
    );
    if (selection) discard(userId, selection, "draft_cleared");
  }, [draftId, getInput, input, userId]);

  const prepareSubmission = useCallback(
    ({
      ordinary,
      text,
    }: {
      /** Not a goal, wait reply or queued/steered message. */
      ordinary: boolean;
      text: string;
    }): StarterSubmission => {
      // The account that owns this attempt, fixed before any await.
      const owner = userId;
      if (!owner || safely(getPermittedAnalyticsUserId, null) !== owner)
        return NO_SUBMISSION;
      const selection = safely(
        () => findSelectionForDraft(owner, draftId),
        undefined,
      );
      if (!selection) return NO_SUBMISSION;
      const mode = chatMode;
      const eligible = ordinary && selection.mode === mode;
      const attemptId = uuidv4();
      const userMessageId = uuidv4();
      let sent: { chatId: string; userMessageId: string } | undefined;
      let settled = false;
      submittingRef.current = true;
      return {
        attribution: eligible
          ? {
              userMessageId,
              onUserMessageSent: (handoff) => {
                if (handoff.userMessageId === userMessageId) sent = handoff;
              },
            }
          : undefined,
        settle: (result) => {
          if (settled) return;
          settled = true;
          submittingRef.current = false;
          asOwner(owner, () => {
            if (result !== "accepted") {
              // Refused or thrown before handoff: keep the selection for retry.
              capture(
                notHandedOffEvent(
                  selection,
                  attemptId,
                  result === "refused" ? "client_refused" : "client_error",
                ),
              );
              return;
            }
            if (!sent) {
              // A submission this attribution excludes consumed the draft.
              discard(
                owner,
                selection,
                selection.mode !== mode
                  ? "mode_changed"
                  : "ineligible_submission",
              );
              return;
            }
            const submitted = {
              ...selection,
              state: "submitted" as const,
              chatId: sent.chatId,
              userMessageId: sent.userMessageId,
              submittedAt: Date.now(),
            };
            if (!saveAttribution(owner, submitted)) return;
            capture(
              submittedEvent(
                submitted,
                attemptId,
                isEditedStarterText(selection.exampleId, text),
              ),
            );
          });
        },
      };
    },
    [chatMode, draftId, userId],
  );

  // Resolve submitted turns from persisted chat state, including after reload.
  useEffect(() => {
    if (!persistedTurn || analyticsOwner !== userId) return;
    asOwner(userId, (owner) => {
      for (const entry of findSubmittedForChat(owner, persistedTurn.chatId)) {
        const resolved = resolveStarterTurn(entry, persistedTurn);
        if (resolved.status === "pending") continue;
        if (resolved.status === "terminal") {
          if (!capture(outcomeEvent(entry, resolved))) continue;
        }
        finishAttribution(owner, entry.selectionId);
      }
    });
  }, [analyticsOwner, persistedTurn, userId]);

  return { recordSelection, prepareSubmission };
}
