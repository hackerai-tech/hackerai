"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { QueuedMessage } from "@/types/chat";
import type { FileMessagePart } from "@/types/file";
import {
  QUEUED_MESSAGE_DISPATCH_CLAIM_TTL_MS,
  QUEUED_MESSAGE_MAX_COUNT,
  sanitizeQueuedFiles,
  type QueuedMessageSettings,
} from "@/lib/chat/queued-message";

// Messages this page session may send without the user's action: the ones it
// queued, and unread steers it sent during the current visit. Anything else on
// the server queue (another tab or device, or before a reload) waits for the
// user, so an old message is never sent behind their back.
const queuedHere = new Set<string>();
const queuedHereListeners = new Set<() => void>();
const STORE_RETRY_MS = 3_000;
const MAX_STORE_ATTEMPTS = 40;
export const markQueuedHere = (id: string) => {
  if (queuedHere.has(id)) return;
  queuedHere.add(id);
  // A row already on screen as held must be shown as sendable again.
  for (const listener of queuedHereListeners) listener();
};
export const isQueuedHere = (id: string) => queuedHere.has(id);

type LocalEntry = {
  /** Present while this tab's own message is not yet confirmed stored. */
  draft?: {
    text: string;
    files?: FileMessagePart[];
    timestamp: number;
  };
  /** Full parts, including local desktop paths that are never stored. */
  files?: FileMessagePart[];
  /** An edit not yet reflected in a server snapshot. */
  editedText?: string;
  /** Seen in a server snapshot; a later absence means it was sent or removed. */
  persisted?: boolean;
  removed?: boolean;
  storing?: boolean;
  /** The server accepted it; its snapshot may not list it yet. */
  stored?: boolean;
  storeFailed?: boolean;
  storeAttempts?: number;
  nextStoreAt?: number;
  deliveryStatus?: QueuedMessage["deliveryStatus"];
  firstAttemptAt?: number;
};

const errorMessage = (error: unknown) =>
  error instanceof ConvexError &&
  typeof (error.data as { message?: unknown })?.message === "string"
    ? (error.data as { message: string }).message
    : undefined;

/**
 * The follow-up queue for accounts with mid-run steering, stored in Convex so
 * it survives reloads and appears on every device. This tab still delivers
 * the messages it queued; the user sends anything else explicitly.
 */
const SETTINGS_RETRY_BASE_MS = 1_000;
const SETTINGS_RETRY_MAX_MS = 30_000;

export function useServerMessageQueue({
  userId,
  chatId,
  enabled,
  settings,
}: {
  userId: string | undefined;
  chatId: string | null;
  enabled: boolean;
  /** The user's current Agent settings; see QueuedMessageSettings. */
  settings?: QueuedMessageSettings;
}) {
  const active = enabled && !!userId && !!chatId;
  const rows = useQuery(
    api.queuedMessages.list,
    active ? { chatId: chatId! } : "skip",
  );
  const enqueue = useMutation(api.queuedMessages.enqueue);
  const update = useMutation(api.queuedMessages.update);
  const remove = useMutation(api.queuedMessages.remove);
  const applySettings = useMutation(api.queuedMessages.applySettings);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // Messages already waiting follow a settings change, so a server send never
  // uses a permission mode or sandbox the user has since switched away from.
  // Mounting sends nothing: another device's choice stays until this one
  // queues, steers or changes a setting. A failed write is retried until it
  // lands or a newer choice replaces it.
  const settingsKey = settings ? JSON.stringify(settings) : "";
  const requestedSettingsKey = useRef<string | null>(settingsKey);
  const settingsFailures = useRef(0);
  const [settingsRetry, setSettingsRetry] = useState(0);
  useEffect(() => {
    if (!enabled || !userId || !settings) return;
    if (requestedSettingsKey.current === settingsKey) return;
    requestedSettingsKey.current = settingsKey;
    applySettings({ settings }).then(
      () => {
        if (requestedSettingsKey.current === settingsKey)
          settingsFailures.current = 0;
      },
      (error: unknown) => {
        console.warn("Could not update queued message settings", error);
        // A newer choice was already sent; it supersedes this one.
        if (requestedSettingsKey.current !== settingsKey) return;
        requestedSettingsKey.current = null;
        const delay = Math.min(
          SETTINGS_RETRY_MAX_MS,
          SETTINGS_RETRY_BASE_MS * 2 ** settingsFailures.current++,
        );
        setTimeout(() => setSettingsRetry((count) => count + 1), delay);
      },
    );
    // settingsKey captures every field of settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applySettings, enabled, settingsKey, settingsRetry, userId]);

  // Local state per account and chat, so async work keeps its original key.
  const key = JSON.stringify([userId ?? null, chatId]);
  const entriesRef = useRef(new Map<string, Map<string, LocalEntry>>());
  const [version, refresh] = useState(0);
  const entriesFor = useCallback((queueKey: string) => {
    let entries = entriesRef.current.get(queueKey);
    if (!entries) {
      entries = new Map();
      entriesRef.current.set(queueKey, entries);
    }
    return entries;
  }, []);
  const patchEntry = useCallback(
    (queueKey: string, id: string, patch: Partial<LocalEntry> | null) => {
      const entries = entriesFor(queueKey);
      if (patch === null) entries.delete(id);
      else entries.set(id, { ...entries.get(id), ...patch });
      refresh((current) => current + 1);
    },
    [entriesFor],
  );

  useEffect(() => {
    const listener = () => refresh((current) => current + 1);
    queuedHereListeners.add(listener);
    return () => {
      queuedHereListeners.delete(listener);
    };
  }, []);

  const entries = entriesFor(key);
  const messageQueue = useMemo<QueuedMessage[]>(() => {
    if (!active) return [];
    const queue: QueuedMessage[] = [];
    const stored = new Set<string>();
    for (const row of rows ?? []) {
      stored.add(row.id);
      const local = entries.get(row.id);
      if (local?.removed) continue;
      queue.push({
        id: row.id,
        text: local?.editedText ?? row.text,
        files: local?.files ?? (row.files as FileMessagePart[] | undefined),
        timestamp: row.sentAt,
        ...(local?.deliveryStatus
          ? {
              deliveryStatus: local.deliveryStatus,
              firstAttemptAt: local.firstAttemptAt,
            }
          : {}),
        ...(row.fromSteer ? { fromSteer: true } : {}),
        // The lease ends on the server's clock; a timer below re-renders then.
        ...(row.dispatchClaimedAt !== undefined &&
        Date.now() - row.dispatchClaimedAt <
          QUEUED_MESSAGE_DISPATCH_CLAIM_TTL_MS
          ? { dispatching: true }
          : {}),
        onServer: true,
        ...(queuedHere.has(row.id) ? {} : { held: true }),
      });
    }
    for (const [id, local] of entries) {
      if (stored.has(id) || !local.draft || local.removed) continue;
      // Stored once and now gone: it was sent or removed elsewhere.
      if (local.persisted && rows) continue;
      queue.push({
        id,
        text: local.editedText ?? local.draft.text,
        files: local.files ?? local.draft.files,
        timestamp: local.draft.timestamp,
        ...(local.deliveryStatus
          ? {
              deliveryStatus: local.deliveryStatus,
              firstAttemptAt: local.firstAttemptAt,
            }
          : {}),
      });
    }
    return queue.sort((a, b) => a.timestamp - b.timestamp);
    // `entries` mutates in place; `version` changes with each update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, rows, entries, version]);

  // A send that died never writes its row again, so end "Sending…" when its
  // lease expires instead of waiting for another queue change. Deadlines come
  // from rows this render shows as sending: one that expired since the render
  // still gets a refresh, and the refreshed render shows none, so no loop.
  useEffect(() => {
    const shownSending = new Set(
      messageQueue
        .filter((message) => message.dispatching)
        .map((message) => message.id),
    );
    const leaseEnds = (rows ?? []).flatMap((row) =>
      shownSending.has(row.id) && row.dispatchClaimedAt !== undefined
        ? [row.dispatchClaimedAt + QUEUED_MESSAGE_DISPATCH_CLAIM_TTL_MS]
        : [],
    );
    if (!leaseEnds.length) return;
    const timer = setTimeout(
      () => refresh((current) => current + 1),
      Math.max(0, Math.min(...leaseEnds) - Date.now()) + 50,
    );
    return () => clearTimeout(timer);
  }, [messageQueue, rows]);

  // Track which of this tab's drafts the server has stored, and drop local
  // state for rows that left the queue.
  useEffect(() => {
    if (!rows) return;
    const stored = new Set(rows.map((row) => row.id));
    let changed = false;
    for (const [id, local] of entries) {
      if (stored.has(id)) {
        const row = rows.find((candidate) => candidate.id === id);
        const editSaved =
          local.editedText !== undefined && row?.text === local.editedText;
        if (!local.persisted || editSaved) {
          entries.set(id, {
            ...local,
            persisted: true,
            ...(editSaved ? { editedText: undefined } : {}),
          });
          changed = true;
        }
      } else if (local.persisted || (local.removed && !local.draft)) {
        entries.delete(id);
        changed = true;
      }
    }
    if (changed) refresh((current) => current + 1);
  }, [rows, entries]);

  // Store drafts for every chat of this account, not only the open one, so a
  // reload cannot lose one adopted for another chat. The server refuses a
  // draft until it has created the chat, so one queued during a new chat's
  // first response retries shortly.
  useEffect(() => {
    if (!enabled || !userId) return;
    const now = Date.now();
    let nextRetryAt = Infinity;
    for (const [queueKey, queueEntries] of entriesRef.current) {
      const [ownerId, draftChatId] = JSON.parse(queueKey) as [
        string | null,
        string | null,
      ];
      if (ownerId !== userId || !draftChatId) continue;
      const isOpenChat = queueKey === key;
      // The open chat's snapshot shows which drafts are already stored.
      if (isOpenChat && rows === undefined) continue;
      const storedIds = new Set(isOpenChat ? rows!.map((row) => row.id) : []);
      for (const [id, local] of queueEntries) {
        if (
          !local.draft ||
          local.removed ||
          local.storing ||
          local.stored ||
          local.storeFailed ||
          local.persisted ||
          storedIds.has(id)
        )
          continue;
        if (local.nextStoreAt !== undefined && local.nextStoreAt > now) {
          nextRetryAt = Math.min(nextRetryAt, local.nextStoreAt);
          continue;
        }
        const attempts = (local.storeAttempts ?? 0) + 1;
        patchEntry(queueKey, id, { storing: true, storeAttempts: attempts });
        void enqueue({
          chatId: draftChatId,
          id,
          text: local.draft.text,
          ...(local.draft.files?.length
            ? { files: sanitizeQueuedFiles(local.draft.files) }
            : {}),
          sentAt: local.draft.timestamp,
          // Queuing sets the user's current settings for every waiting message.
          ...(settingsRef.current ? { settings: settingsRef.current } : {}),
        })
          .then(() => {
            patchEntry(queueKey, id, { storing: false, stored: true });
            // Removed while it was being stored: remove the stored copy too.
            if (entriesFor(queueKey).get(id)?.removed)
              void remove({ chatId: draftChatId, id })
                .then(() => patchEntry(queueKey, id, null))
                .catch((error: unknown) => {
                  // Show it again rather than hide a row the server kept.
                  patchEntry(queueKey, id, { removed: false });
                  toast.error(
                    errorMessage(error) ?? "Could not remove the message.",
                  );
                });
          })
          .catch((error: unknown) => {
            const code =
              error instanceof ConvexError
                ? (error.data as { code?: unknown })?.code
                : undefined;
            // The draft still sends from this tab; storing only adds recovery.
            const giveUp =
              code !== "ACCESS_DENIED" || attempts >= MAX_STORE_ATTEMPTS;
            patchEntry(queueKey, id, {
              storing: false,
              ...(giveUp
                ? { storeFailed: true }
                : { nextStoreAt: Date.now() + STORE_RETRY_MS }),
            });
          });
      }
    }
    if (nextRetryAt === Infinity) return;
    const timer = setTimeout(
      () => refresh((current) => current + 1),
      Math.max(0, nextRetryAt - now),
    );
    return () => clearTimeout(timer);
  }, [
    enabled,
    userId,
    rows,
    version,
    key,
    enqueue,
    remove,
    entriesFor,
    patchEntry,
  ]);

  const queueMessage = useCallback(
    (text: string, files?: FileMessagePart[]) => {
      if (!active) return undefined;
      if (messageQueue.length >= QUEUED_MESSAGE_MAX_COUNT) {
        toast.error("Queue is full", {
          description:
            "Please wait for queued messages to send before adding more.",
        });
        return undefined;
      }
      const id = uuidv4();
      markQueuedHere(id);
      patchEntry(key, id, {
        draft: { text, files, timestamp: Date.now() },
        ...(files?.length ? { files } : {}),
      });
      return id;
    },
    [active, key, messageQueue.length, patchEntry],
  );

  const updateQueuedMessage = useCallback(
    (id: string, text: string) => {
      const local = entries.get(id);
      if (local?.deliveryStatus) return;
      if (local?.draft && !local.persisted && !local.stored) {
        patchEntry(key, id, { draft: { ...local.draft, text } });
        // Not stored yet: the pending store sends the edited text.
        if (!local.storing) return;
      }
      patchEntry(key, id, { editedText: text });
      if (!chatId) return;
      void update({ chatId, id, text }).catch((error: unknown) => {
        patchEntry(key, id, { editedText: undefined });
        toast.error(errorMessage(error) ?? "Could not edit the message.");
      });
    },
    [chatId, entries, key, patchEntry, update],
  );

  const removeQueuedMessage = useCallback(
    (id: string) => {
      const local = entries.get(id);
      const unstored = !!local?.draft && !local.persisted && !local.stored;
      // Never stored and not being stored: nothing to remove on the server.
      if (unstored && !local?.storing) {
        patchEntry(key, id, null);
        return;
      }
      patchEntry(key, id, { removed: true });
      // Still being stored: the store's completion removes the stored copy.
      if (!chatId || unstored) return;
      void remove({ chatId, id })
        .then(() => {
          if (entriesFor(key).get(id)?.removed) patchEntry(key, id, null);
        })
        .catch((error: unknown) => {
          patchEntry(key, id, { removed: false });
          toast.error(errorMessage(error) ?? "Could not remove the message.");
        });
    },
    [chatId, entries, entriesFor, key, patchEntry, remove],
  );

  const setQueuedMessageDelivery = useCallback(
    (
      id: string,
      deliveryStatus: NonNullable<QueuedMessage["deliveryStatus"]>,
      firstAttemptAt: number,
    ) => patchEntry(key, id, { deliveryStatus, firstAttemptAt }),
    [key, patchEntry],
  );

  const clearQueue = useCallback(() => {
    for (const message of messageQueue) removeQueuedMessage(message.id);
  }, [messageQueue, removeQueuedMessage]);

  /**
   * Takes over messages this tab queued in its session-only queue before the
   * steering rollout resolved, keeping their IDs and delivery state.
   */
  const adoptLocalMessages = useCallback(
    (adoptChatId: string, messages: QueuedMessage[]) => {
      if (!userId) return;
      const queueKey = JSON.stringify([userId, adoptChatId]);
      const adopted = entriesFor(queueKey);
      for (const message of messages) {
        if (adopted.has(message.id)) continue;
        markQueuedHere(message.id);
        adopted.set(message.id, {
          draft: {
            text: message.text,
            files: message.files,
            timestamp: message.timestamp,
          },
          ...(message.files?.length ? { files: message.files } : {}),
          ...(message.deliveryStatus
            ? {
                deliveryStatus: message.deliveryStatus,
                firstAttemptAt: message.firstAttemptAt,
              }
            : {}),
        });
      }
      refresh((current) => current + 1);
    },
    [entriesFor, userId],
  );

  return {
    adoptLocalMessages,
    messageQueue,
    queueMessage,
    updateQueuedMessage,
    removeQueuedMessage,
    setQueuedMessageDelivery,
    clearQueue,
  };
}
