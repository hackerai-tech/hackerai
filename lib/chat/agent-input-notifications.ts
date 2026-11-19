/**
 * Opt-in, generic alerts for saved Agent questions and approvals.
 *
 * The server returns only `{ chatId, requestId }`. Each subscription treats
 * its first snapshot as a baseline, so reloads and reconnects do not replay
 * old waits. A per-account receipt ledger, claimed under a Web Lock, keeps
 * same-origin tabs and windows from alerting twice for one request. Without
 * Web Locks the feature is unavailable rather than unsafely deduplicated.
 */

export type PendingAgentInput = { chatId: string; requestId: string };

export type AgentInputPermission =
  "granted" | "prompt" | "denied" | "unavailable";

export type AgentInputTransport = "desktop" | "browser";

/** Fixed, content-free title. Desktop sets the same title natively. */
export const AGENT_INPUT_NOTIFICATION_TITLE = "HackerAI needs your input";
/** Native click events carry only a chat ID, validated again here. */
export const AGENT_INPUT_NOTIFICATION_OPEN_EVENT =
  "agent-input-notification-open";
/** Covers 100 active chats with a question and an approval each. */
export const MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS = 256;
const MAX_SEEN_REQUEST_IDS = 512;

const PREFERENCE_PREFIX = "agent_input_notifications:v1:";
const RECEIPTS_PREFIX = "agent_input_notification_receipts:v1:";
const PREFERENCE_CHANGE_EVENT = "hackerai:agent-input-notifications";
/** Matches `is_chat_id` in the Desktop notifications module. */
const MAX_CHAT_ID_BYTES = 256;
const UNSAFE_CHAT_ID_CHARACTER = /[\p{Cc}/\\?#]/u;

function utf8Length(value: string): number | null {
  try {
    return encodeURIComponent(value).replace(/%[0-9A-F]{2}/g, "_").length;
  } catch {
    return null; // Lone surrogates cannot be routed.
  }
}

/** One safe `/c/<id>` path segment; legacy slugs are allowed. */
export function isAgentInputChatId(chatId: string): boolean {
  const length = utf8Length(chatId);
  return (
    length !== null &&
    length > 0 &&
    length <= MAX_CHAT_ID_BYTES &&
    chatId !== "." &&
    chatId !== ".." &&
    !UNSAFE_CHAT_ID_CHARACTER.test(chatId)
  );
}

export function agentInputChatPath(chatId: string): string | null {
  return isAgentInputChatId(chatId) ? `/c/${encodeURIComponent(chatId)}` : null;
}

const permissionValues = new Set<AgentInputPermission>([
  "granted",
  "prompt",
  "denied",
  "unavailable",
]);

// ---------------------------------------------------------------------------
// Preference (local to this browser profile or Desktop install, per account)

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readAgentInputNotificationsEnabled(userId: string): boolean {
  try {
    return getStorage()?.getItem(PREFERENCE_PREFIX + userId) === "on";
  } catch {
    return false;
  }
}

/** Returns false when storage is unavailable, so the switch stays off. */
export function writeAgentInputNotificationsEnabled(
  userId: string,
  enabled: boolean,
): boolean {
  const storage = getStorage();
  if (!storage) return false;
  try {
    if (enabled) storage.setItem(PREFERENCE_PREFIX + userId, "on");
    else storage.removeItem(PREFERENCE_PREFIX + userId);
  } catch {
    return false;
  }
  window.dispatchEvent(new Event(PREFERENCE_CHANGE_EVENT));
  return readAgentInputNotificationsEnabled(userId) === enabled;
}

export function subscribeAgentInputNotificationsEnabled(
  userId: string,
  onChange: () => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handleStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === PREFERENCE_PREFIX + userId)
      onChange();
  };
  window.addEventListener("storage", handleStorage);
  window.addEventListener(PREFERENCE_CHANGE_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", handleStorage);
    window.removeEventListener(PREFERENCE_CHANGE_EVENT, onChange);
  };
}

// ---------------------------------------------------------------------------
// Baseline tracker

export type AgentInputNotificationTracker = {
  /** Returns requests that first became pending after this subscription began. */
  observe(
    pending: readonly PendingAgentInput[] | undefined,
  ): PendingAgentInput[];
};

export function createAgentInputNotificationTracker(): AgentInputNotificationTracker {
  let seeded = false;
  const seen = new Set<string>();

  return {
    observe(pending) {
      // Loading or reconnecting: keep seen IDs so a resumed wait is not new.
      if (pending === undefined) return [];
      const fresh: PendingAgentInput[] = [];
      for (const item of pending) {
        if (seen.has(item.requestId)) continue;
        seen.add(item.requestId);
        if (seeded) fresh.push(item);
      }
      seeded = true;
      // Forget the oldest finished waits, never one that is still pending.
      const active = new Set(pending.map((item) => item.requestId));
      for (const requestId of seen) {
        if (seen.size <= MAX_SEEN_REQUEST_IDS) break;
        if (!active.has(requestId)) seen.delete(requestId);
      }
      return fresh;
    },
  };
}

// ---------------------------------------------------------------------------
// Cross-window claim

function parseReceipts(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** Check-and-record one request. Callers hold the account's Web Lock. */
export function claimAgentInputNotificationReceipt(
  storage: Storage,
  userId: string,
  requestId: string,
): boolean {
  const key = RECEIPTS_PREFIX + userId;
  try {
    const receipts = parseReceipts(storage.getItem(key));
    if (receipts.includes(requestId)) return false;
    const next = [...receipts, requestId].slice(
      -MAX_AGENT_INPUT_NOTIFICATION_RECEIPTS,
    );
    storage.setItem(key, JSON.stringify(next));
    // Quota or privacy modes can drop the write; never alert unrecorded.
    return parseReceipts(storage.getItem(key)).includes(requestId);
  } catch {
    return false;
  }
}

type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

function getLockManager(): LockManagerLike | null {
  if (typeof navigator === "undefined") return null;
  const locks = (navigator as Navigator & { locks?: LockManagerLike }).locks;
  return locks && typeof locks.request === "function" ? locks : null;
}

export function isWebLocksSupported(): boolean {
  return getLockManager() !== null;
}

/**
 * Claims the request across same-origin windows under a lock held only for
 * the claim, rechecks the latest state, then shows one notification.
 */
export async function deliverAgentInputNotification({
  userId,
  requestId,
  shouldDeliver,
  show,
}: {
  userId: string;
  requestId: string;
  shouldDeliver: () => boolean;
  show: () => Promise<boolean> | boolean;
}): Promise<boolean> {
  const storage = getStorage();
  const locks = getLockManager();
  if (!storage || !locks || !shouldDeliver()) return false;
  try {
    const claimed = await locks.request(
      `hackerai-agent-input:${userId}`,
      async () =>
        shouldDeliver() &&
        claimAgentInputNotificationReceipt(storage, userId, requestId),
    );
    if (!claimed || !shouldDeliver()) return false;
    return await show();
  } catch {
    return false;
  }
}

export function isDocumentForeground(doc: Document = document): boolean {
  return doc.visibilityState === "visible" && doc.hasFocus();
}

export function isPendingAgentInput(
  pending: readonly PendingAgentInput[] | undefined,
  requestId: string,
): boolean {
  return pending?.some((item) => item.requestId === requestId) ?? false;
}

// ---------------------------------------------------------------------------
// Browser transport: open tabs only, never a worker or push subscription.

function isMobileBrowser(nav: Navigator): boolean {
  const mobileHint = (
    nav as Navigator & { userAgentData?: { mobile?: boolean } }
  ).userAgentData?.mobile;
  if (typeof mobileHint === "boolean") return mobileHint;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(nav.userAgent)) return true;
  // iPadOS reports a desktop Mac user agent.
  return /Macintosh/.test(nav.userAgent) && nav.maxTouchPoints > 1;
}

export function isBrowserNotificationSupported(): boolean {
  if (typeof window === "undefined" || !window.isSecureContext) return false;
  if (typeof window.Notification !== "function" || !isWebLocksSupported())
    return false;
  return !isMobileBrowser(window.navigator);
}

/** Null where alerts cannot be delivered and deduplicated safely. */
export function detectAgentInputTransport(
  isDesktopApp: boolean,
): AgentInputTransport | null {
  if (typeof window === "undefined") return null;
  if (isDesktopApp) return isWebLocksSupported() ? "desktop" : null;
  return isBrowserNotificationSupported() ? "browser" : null;
}

export function getBrowserNotificationPermission(): AgentInputPermission {
  if (!isBrowserNotificationSupported()) return "unavailable";
  const permission = window.Notification.permission;
  return permission === "default" ? "prompt" : permission;
}

export async function requestBrowserNotificationPermission(): Promise<AgentInputPermission> {
  if (!isBrowserNotificationSupported()) return "unavailable";
  try {
    const permission = await window.Notification.requestPermission();
    return permission === "default" ? "prompt" : permission;
  } catch {
    return getBrowserNotificationPermission();
  }
}

export function showBrowserAgentInputNotification(
  item: PendingAgentInput,
  openChat: (chatId: string) => void,
): boolean {
  if (getBrowserNotificationPermission() !== "granted") return false;
  try {
    const notification = new window.Notification(
      AGENT_INPUT_NOTIFICATION_TITLE,
      { tag: item.requestId },
    );
    notification.onclick = () => {
      window.focus();
      openChat(item.chatId);
      notification.close();
    };
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Desktop transport: two scoped native commands, no web fallback.

async function invokeDesktop<T>(
  command: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(command, args);
}

/** Older Desktop builds lack the command; treat any failure as unavailable. */
export async function getDesktopNotificationPermission(
  request: boolean,
): Promise<AgentInputPermission> {
  try {
    const result = await invokeDesktop<string>(
      "agent_notification_permission",
      { request },
    );
    return permissionValues.has(result as AgentInputPermission)
      ? (result as AgentInputPermission)
      : "unavailable";
  } catch {
    return "unavailable";
  }
}

export async function showDesktopAgentInputNotification(
  chatId: string,
): Promise<boolean> {
  if (!isAgentInputChatId(chatId)) return false;
  try {
    return (
      (await invokeDesktop<boolean>("show_agent_input_notification", {
        chatId,
      })) === true
    );
  } catch {
    return false;
  }
}

export async function listenForDesktopNotificationOpen(
  openChat: (chatId: string) => void,
): Promise<() => void> {
  try {
    const { listen } = await import("@tauri-apps/api/event");
    return await listen<string>(
      AGENT_INPUT_NOTIFICATION_OPEN_EVENT,
      (event) => {
        if (typeof event.payload === "string") openChat(event.payload);
      },
    );
  } catch {
    return () => undefined;
  }
}
