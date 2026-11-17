import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType } from "@/lib/utils/file-utils";
import type { ChatMessage } from "@/types";
import { useS3ActionDiagnostics } from "./useS3ActionDiagnostics";

interface CachedUrl {
  url: string;
  expiresAt: number;
}

const URL_CACHE_EXPIRATION = 50 * 60 * 1000;
const SIGNED_URL_SAFETY_MARGIN = 60 * 1000;

function getCacheLifetime(url: string): number {
  try {
    const lifetimes = new URL(url).searchParams.getAll("X-Amz-Expires");
    if (lifetimes.length === 0) return URL_CACHE_EXPIRATION;
    if (lifetimes.length !== 1 || !/^\d+$/.test(lifetimes[0])) return 0;
    const seconds = Number(lifetimes[0]);
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return 0;
    return Math.max(
      0,
      Math.min(URL_CACHE_EXPIRATION, seconds * 1000 - SIGNED_URL_SAFETY_MARGIN),
    );
  } catch {
    return 0;
  }
}
const MAX_BATCH_SIZE = 50; // Must match server-side limit in convex/s3Actions.ts

interface UrlRequest {
  promise: Promise<string | null>;
  resolve: (url: string | null) => void;
  reject: (error: unknown) => void;
  settled: boolean;
}

/**
 * Requests made under one authentication state. Losing or refreshing
 * authentication, unmounting and StrictMode replay end the scope: its waiting
 * callers are rejected with an AbortError and unsent batches are discarded.
 * Actions already sent still complete on the server; their results are ignored.
 */
interface AuthScope {
  ready: boolean;
  signal: AbortSignal;
  /** In flight, or settled as unavailable/failed so prefetch does not repeat it. */
  requests: Map<string, UrlRequest>;
  /** Requested since the last dispatch; sent together in the next microtask. */
  queued: Set<string>;
}

function abortError() {
  return new DOMException("Image URL request was superseded", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return (error as { name?: unknown } | null)?.name === "AbortError";
}

function createRequest(): UrlRequest {
  let resolve!: (url: string | null) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string | null>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Callers handle rejections; an image nobody is waiting for must not warn.
  promise.catch(() => {});
  const request: UrlRequest = {
    promise,
    settled: false,
    resolve: (url) => {
      request.settled = true;
      resolve(url);
    },
    reject: (error) => {
      request.settled = true;
      reject(error);
    },
  };
  return request;
}

function imageFileIds(messages: ChatMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const file of message.fileDetails ?? []) {
      if (
        file.s3Key &&
        file.mediaType &&
        isSupportedImageMediaType(file.mediaType)
      )
        ids.add(file.fileId);
    }
    for (const part of message.parts) {
      // Uploaded parts carry only their file ID; the server signs what exists.
      if (
        part.type === "file" &&
        "fileId" in part &&
        typeof part.fileId === "string" &&
        !("storage" in part && part.storage === "local-desktop") &&
        part.mediaType &&
        isSupportedImageMediaType(part.mediaType)
      )
        ids.add(part.fileId);
    }
  }
  return [...ids];
}

/**
 * Owns signed URLs for a chat's files.
 *
 * - `loadImageUrl` shares one request per file: everything asked for in the
 *   same tick, by mounted images or by the history prefetch, goes out in
 *   batches of up to 50. A file the batch cannot sign is asked for once on its
 *   own. Later ticks are sent without waiting for earlier batches.
 * - Images in the messages are requested as soon as authentication is ready.
 * - Fresh URLs are cached for at most 50 minutes, shortened for their signed
 *   lifetime, and expired entries are cleaned up periodically.
 */
export function useFileUrlCache(messages: ChatMessage[]) {
  const { isAuthenticated, isLoading, isRefreshing } = useConvexAuth();
  const authReady = isAuthenticated && !isLoading && !isRefreshing;
  const getFileUrlsBatchAction = useAction(
    api.s3Actions.getFileUrlsBatchAction,
  );
  const getFileUrlAction = useS3ActionDiagnostics(
    "inline_image",
    useAction(api.s3Actions.getFileUrlAction),
  );
  const urlCacheRef = useRef<Map<string, CachedUrl>>(new Map());
  const scopeRef = useRef<AuthScope | null>(null);

  useLayoutEffect(() => {
    const controller = new AbortController();
    const scope: AuthScope = {
      ready: authReady,
      signal: controller.signal,
      requests: new Map(),
      queued: new Set(),
    };
    scopeRef.current = scope;
    if (!authReady) urlCacheRef.current.clear();
    // Ends during commit, before pending responses can resume.
    return () => {
      controller.abort();
      scope.queued.clear();
      for (const request of scope.requests.values())
        if (!request.settled) request.reject(abortError());
      scope.requests.clear();
    };
  }, [authReady]);

  // Get cached URL for a file (returns null if expired or not cached)
  const getCachedUrl = useCallback((fileId: string): string | null => {
    const cached = urlCacheRef.current.get(fileId);
    if (!cached) return null;

    if (Date.now() >= cached.expiresAt) {
      urlCacheRef.current.delete(fileId);
      return null;
    }

    return cached.url;
  }, []);

  // Set/update cached URL for a file
  const setCachedUrl = useCallback((fileId: string, url: string) => {
    const lifetime = getCacheLifetime(url);
    if (lifetime <= 0) {
      urlCacheRef.current.delete(fileId);
      return;
    }
    // Actions sign fresh URLs on demand. Start their TTL on receipt so server
    // and browser clock differences cannot extend or prematurely expire it.
    urlCacheRef.current.set(fileId, { url, expiresAt: Date.now() + lifetime });
  }, []);

  const sendBatch = useCallback(
    async (scope: AuthScope, fileIds: string[]) => {
      const deliver = (fileId: string, url: string | null) => {
        const request = scope.requests.get(fileId);
        if (!request || request.settled || scope.signal.aborted) return;
        if (url) {
          setCachedUrl(fileId, url);
          // The cache owns successful URLs, so an expired one is asked again.
          scope.requests.delete(fileId);
        }
        request.resolve(url);
      };

      let urls: Record<string, string> = {};
      try {
        const result = await getFileUrlsBatchAction({
          fileIds: fileIds as Array<Id<"files">>,
        });
        if (result && typeof result === "object") urls = result;
      } catch (error) {
        if (scope.signal.aborted) return;
        console.error("Failed to load image URLs:", error);
      }
      if (scope.signal.aborted) return;

      for (const fileId of fileIds) {
        const request = scope.requests.get(fileId);
        if (!request || request.settled) continue;
        if (urls[fileId]) {
          deliver(fileId, urls[fileId]);
          continue;
        }
        // Ask once more on its own; a null answer means the file is gone.
        getFileUrlAction({ fileId: fileId as Id<"files"> }).then(
          (url) => deliver(fileId, url),
          (error) => {
            if (!request.settled && !scope.signal.aborted)
              request.reject(error);
          },
        );
      }
    },
    [getFileUrlAction, getFileUrlsBatchAction, setCachedUrl],
  );

  const requestImageUrl = useCallback(
    (fileId: string, retrySettled: boolean): Promise<string | null> => {
      const cached = getCachedUrl(fileId);
      if (cached) return Promise.resolve(cached);
      const scope = scopeRef.current;
      if (!authReady || !scope?.ready || scope.signal.aborted)
        return Promise.reject(abortError());
      const existing = scope.requests.get(fileId);
      if (existing && (!existing.settled || !retrySettled))
        return existing.promise;

      const request = createRequest();
      scope.requests.set(fileId, request);
      if (scope.queued.size === 0) {
        queueMicrotask(() => {
          if (scope.signal.aborted) return;
          const ids = [...scope.queued];
          scope.queued.clear();
          for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE)
            void sendBatch(scope, ids.slice(i, i + MAX_BATCH_SIZE));
        });
      }
      scope.queued.add(fileId);
      return request.promise;
    },
    [authReady, getCachedUrl, sendBatch],
  );

  // A newly shown image asks again for a file that failed or was unavailable.
  // Identity changes with authentication, so shown images load again.
  const loadImageUrl = useCallback(
    (fileId: string) => requestImageUrl(fileId, true),
    [requestImageUrl],
  );

  // Request every image in the history; mounted images share these requests.
  // Settled failures are left alone so streamed renders do not repeat them.
  useEffect(() => {
    if (!authReady) return;
    for (const fileId of imageFileIds(messages))
      requestImageUrl(fileId, false).catch(() => {});
  }, [messages, authReady, requestImageUrl]);

  // Cleanup expired URLs periodically
  useEffect(() => {
    const cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        for (const [fileId, cached] of urlCacheRef.current.entries()) {
          if (now >= cached.expiresAt) urlCacheRef.current.delete(fileId);
        }
      },
      5 * 60 * 1000,
    ); // Clean up every 5 minutes

    return () => clearInterval(cleanupInterval);
  }, []);

  return { getCachedUrl, setCachedUrl, loadImageUrl };
}
