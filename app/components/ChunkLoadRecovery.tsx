"use client";

import { useEffect } from "react";

const CHUNK_LOAD_RELOAD_STORAGE_KEY = "zhacker:chunk-load-reload-at";
const CHUNK_LOAD_RELOAD_COOLDOWN_MS = 5 * 60 * 1_000;

const CHUNK_LOAD_PATTERNS = [
  /ChunkLoadError/i,
  /Failed to load chunk/i,
  /Loading chunk \d+ failed/i,
  /error loading dynamically imported module/i,
  /Importing a module script failed/i,
  /Failed to fetch dynamically imported module/i,
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

export function maybeRecoverFromChunkLoadFailure(
  error: unknown,
  {
    storage,
    reload,
    now = Date.now(),
    cooldownMs = CHUNK_LOAD_RELOAD_COOLDOWN_MS,
  }: {
    storage: StorageLike;
    reload: () => void;
    now?: number;
    cooldownMs?: number;
  },
): boolean {
  if (!isChunkLoadFailure(error)) return false;

  try {
    const storedReloadedAt = storage.getItem(CHUNK_LOAD_RELOAD_STORAGE_KEY);
    const lastReloadedAt =
      storedReloadedAt === null ? undefined : Number(storedReloadedAt);
    if (
      lastReloadedAt !== undefined &&
      Number.isFinite(lastReloadedAt) &&
      now - lastReloadedAt < cooldownMs
    ) {
      return false;
    }

    storage.setItem(CHUNK_LOAD_RELOAD_STORAGE_KEY, String(now));
  } catch {
    // Storage can be unavailable in restricted browser modes; still recover.
  }

  reload();
  return true;
}

export function ChunkLoadRecovery() {
  useEffect(() => {
    const recover = (error: unknown) => {
      maybeRecoverFromChunkLoadFailure(error, {
        storage: window.sessionStorage,
        reload: () => window.location.reload(),
      });
    };

    const onError = (event: ErrorEvent) => {
      recover(event.error ?? event.message);
    };

    const onUnhandledRejection = (event: PromiseRejectionEvent) => {
      recover(event.reason);
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
