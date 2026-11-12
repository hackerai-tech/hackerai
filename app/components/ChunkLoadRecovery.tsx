"use client";

import { useEffect } from "react";

import { recordGlobalServerActionDecision } from "@/lib/analytics/server-action-diagnostics";
import { getSafeErrorEventCause } from "@/lib/utils/error-event";

const CHUNK_LOAD_RELOAD_STORAGE_KEY = "hackerai:chunk-load-reload-at";
const CHUNK_LOAD_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

const CHUNK_LOAD_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i,
  /Loading chunk \d+ failed/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
];

const STALE_SERVER_ACTION_PATTERNS = [
  /Failed to find Server Action/i,
  /Server Action\s+"[^"]+"\s+was not found on the server/i,
  /failed-to-find-server-action/i,
  /older or newer deployment/i,
];

type StorageLike = Pick<Storage, "getItem" | "setItem">;

function collectErrorStrings(
  value: unknown,
  strings: string[] = [],
  seen: WeakSet<object> = new WeakSet(),
): string[] {
  if (typeof value === "string") {
    strings.push(value);
    return strings;
  }

  if (value instanceof Error) {
    if (seen.has(value)) return strings;
    seen.add(value);
    strings.push(value.name, value.message);
    if (value.stack) strings.push(value.stack);
    return strings;
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) return strings;
    seen.add(value);
    for (const item of value) {
      collectErrorStrings(item, strings, seen);
    }
    return strings;
  }

  if (value && typeof value === "object") {
    if (seen.has(value)) return strings;
    seen.add(value);
    for (const nestedValue of Object.values(value)) {
      collectErrorStrings(nestedValue, strings, seen);
    }
  }

  return strings;
}

export function isChunkLoadFailure(error: unknown): boolean {
  const strings = collectErrorStrings(error);
  return strings.some((value) =>
    CHUNK_LOAD_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

export function isStaleServerActionFailure(error: unknown): boolean {
  const strings = collectErrorStrings(error);
  return strings.some((value) =>
    STALE_SERVER_ACTION_PATTERNS.some((pattern) => pattern.test(value)),
  );
}

export function isRecoverableClientStalenessFailure(error: unknown): boolean {
  return isChunkLoadFailure(error) || isStaleServerActionFailure(error);
}

type RecoveryDecision = "reload_requested" | "cooldown_skipped";

function notifyDecision(
  onDecision: ((decision: RecoveryDecision) => void) | undefined,
  decision: RecoveryDecision,
) {
  try {
    onDecision?.(decision);
  } catch {
    // Observation is optional and never changes recovery.
  }
}

export function maybeRecoverFromClientStalenessFailure(
  error: unknown,
  {
    storage,
    reload,
    now = Date.now(),
    cooldownMs = CHUNK_LOAD_RELOAD_COOLDOWN_MS,
    onDecision,
  }: {
    storage: StorageLike;
    reload: () => void;
    now?: number;
    cooldownMs?: number;
    onDecision?: (decision: RecoveryDecision) => void;
  },
): boolean {
  if (!isRecoverableClientStalenessFailure(error)) return false;

  try {
    const storedReloadedAt = storage.getItem(CHUNK_LOAD_RELOAD_STORAGE_KEY);
    const lastReloadedAt =
      storedReloadedAt === null ? undefined : Number(storedReloadedAt);
    if (
      lastReloadedAt !== undefined &&
      Number.isFinite(lastReloadedAt) &&
      now - lastReloadedAt < cooldownMs
    ) {
      notifyDecision(onDecision, "cooldown_skipped");
      return false;
    }

    storage.setItem(CHUNK_LOAD_RELOAD_STORAGE_KEY, String(now));
  } catch {
    // Storage can be unavailable in restricted browser modes; still recover.
  }

  notifyDecision(onDecision, "reload_requested");
  reload();
  return true;
}

export const maybeRecoverFromChunkLoadFailure =
  maybeRecoverFromClientStalenessFailure;

export function ChunkLoadRecovery() {
  useEffect(() => {
    const recover = (
      error: unknown,
      caller: "global_error" | "global_unhandled_rejection",
    ) =>
      maybeRecoverFromClientStalenessFailure(error, {
        storage: window.sessionStorage,
        reload: () => window.location.reload(),
        onDecision: (decision) =>
          recordGlobalServerActionDecision(caller, error, decision),
      });

    const onError = (event: ErrorEvent) => {
      if (recover(getSafeErrorEventCause(event), "global_error")) {
        event.preventDefault();
      }
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      if (recover(event.reason, "global_unhandled_rejection")) {
        event.preventDefault();
      }
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onUnhandledRejection);

    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onUnhandledRejection);
    };
  }, []);

  return null;
}
