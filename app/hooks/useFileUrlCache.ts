import { useEffect, useLayoutEffect, useRef, useCallback } from "react";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType } from "@/lib/utils/file-utils";
import type { ChatMessage } from "@/types";

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

/**
 * Hook to manage prefetching and caching of file URLs
 *
 * Features:
 * - Batch prefetches URLs for all S3 image files in messages (images need eager loading)
 * - Caches fresh URLs for at most 50 minutes, shortened for their signed lifetime
 * - Provides methods to get and set cached URLs (for lazy-loaded non-image files)
 * - Automatically cleans up expired URLs
 */
export function useFileUrlCache(messages: ChatMessage[]) {
  const { isAuthenticated, isLoading, isRefreshing } = useConvexAuth();
  const authReady = isAuthenticated && !isLoading && !isRefreshing;
  const getFileUrlsBatchAction = useAction(
    api.s3Actions.getFileUrlsBatchAction,
  );
  const urlCacheRef = useRef<Map<string, CachedUrl>>(new Map());
  const prefetchedIdsRef = useRef<Set<string>>(new Set());
  const pendingIdsRef = useRef<Set<string>>(new Set());
  const prefetchQueueRef = useRef<Promise<void> | null>(null);
  const authScopeRef = useRef(new AbortController());

  useLayoutEffect(() => {
    const scope = new AbortController();
    authScopeRef.current = scope;
    // Each scope owns its reservations, including React's effect replay.
    pendingIdsRef.current.clear();
    prefetchQueueRef.current = null;
    if (!authReady) {
      urlCacheRef.current.clear();
      prefetchedIdsRef.current.clear();
    }
    // Invalidate during commit, before pending responses can resume.
    // Pending reads cannot be canceled by Convex, but their results and queued
    // batches must not survive a loss of authentication or an unmount.
    return () => scope.abort();
  }, [authReady]);

  // Get cached URL for a file (returns null if expired or not cached)
  const getCachedUrl = useCallback((fileId: string): string | null => {
    const cached = urlCacheRef.current.get(fileId);
    if (!cached) return null;

    // Check if URL has expired
    const now = Date.now();
    if (now >= cached.expiresAt) {
      urlCacheRef.current.delete(fileId);
      prefetchedIdsRef.current.delete(fileId);
      return null;
    }

    return cached.url;
  }, []);

  // Set/update cached URL for a file (used for lazy-loaded non-image files)
  const setCachedUrl = useCallback((fileId: string, url: string) => {
    const lifetime = getCacheLifetime(url);
    if (lifetime <= 0) {
      urlCacheRef.current.delete(fileId);
      prefetchedIdsRef.current.delete(fileId);
      return;
    }
    // Actions sign fresh URLs on demand. Start their TTL on receipt so server
    // and browser clock differences cannot extend or prematurely expire it.
    urlCacheRef.current.set(fileId, { url, expiresAt: Date.now() + lifetime });
    prefetchedIdsRef.current.add(fileId);
  }, []);

  // Prefetch image URLs for messages
  useEffect(() => {
    if (!authReady) return;
    const scope = authScopeRef.current;
    async function prefetchImageUrls() {
      // Track seen fileIds within this run to avoid duplicates
      const seenInThisRun = new Set<string>();
      const s3ImageFiles: Array<{
        fileId: Id<"files">;
        mediaType: string;
      }> = [];

      for (const message of messages) {
        if (!message.fileDetails) continue;

        for (const file of message.fileDetails) {
          // Only process files that:
          // 1. Have an S3 key
          // 2. Are supported image types
          // 3. Haven't been prefetched yet
          // 4. Haven't been seen in this run
          if (
            file.s3Key &&
            file.mediaType &&
            isSupportedImageMediaType(file.mediaType) &&
            !prefetchedIdsRef.current.has(file.fileId) &&
            !pendingIdsRef.current.has(file.fileId) &&
            !seenInThisRun.has(file.fileId)
          ) {
            s3ImageFiles.push({
              fileId: file.fileId,
              mediaType: file.mediaType,
            });
            seenInThisRun.add(file.fileId);
          }
        }
      }

      // Also collect image files from message parts
      for (const message of messages) {
        for (const part of message.parts) {
          if (
            part.type === "file" &&
            "fileId" in part &&
            "s3Key" in part &&
            part.s3Key &&
            part.mediaType &&
            isSupportedImageMediaType(part.mediaType) &&
            typeof part.fileId === "string" &&
            !prefetchedIdsRef.current.has(part.fileId) &&
            !pendingIdsRef.current.has(part.fileId) &&
            !seenInThisRun.has(part.fileId)
          ) {
            s3ImageFiles.push({
              fileId: part.fileId as Id<"files">,
              mediaType: part.mediaType,
            });
            seenInThisRun.add(part.fileId);
          }
        }
      }

      // If no new images to prefetch, return early
      if (s3ImageFiles.length === 0) {
        return;
      }

      // Reserve all IDs before awaiting so streaming renders cannot enqueue them again.
      const fileIds = s3ImageFiles.map((f) => f.fileId);
      for (const fileId of fileIds) pendingIdsRef.current.add(fileId);
      const chunks: Array<Array<Id<"files">>> = [];
      for (let i = 0; i < fileIds.length; i += MAX_BATCH_SIZE) {
        chunks.push(fileIds.slice(i, i + MAX_BATCH_SIZE));
      }

      const runBatches = async () => {
        for (const chunk of chunks) {
          if (scope.signal.aborted) return;
          try {
            const urlMap = await getFileUrlsBatchAction({ fileIds: chunk });
            if (scope.signal.aborted) return;
            if (urlMap && typeof urlMap === "object") {
              for (const [fileId, url] of Object.entries(urlMap) as Array<
                [string, string]
              >) {
                setCachedUrl(fileId, url);
              }
            }
          } catch (error) {
            if (!scope.signal.aborted)
              console.error("Failed to prefetch image URLs:", error);
          } finally {
            if (!scope.signal.aborted)
              for (const fileId of chunk) pendingIdsRef.current.delete(fileId);
          }
        }
      };

      // Serialize across effects too: newly arriving IDs wait behind active work.
      const previousWork = prefetchQueueRef.current;
      prefetchQueueRef.current = previousWork
        ? previousWork.then(runBatches, runBatches)
        : runBatches();
      await prefetchQueueRef.current;
    }

    prefetchImageUrls();
  }, [messages, getFileUrlsBatchAction, authReady, setCachedUrl]);

  // Cleanup expired URLs periodically
  useEffect(() => {
    const cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const entriesToDelete: string[] = [];

        for (const [fileId, cached] of urlCacheRef.current.entries()) {
          if (now >= cached.expiresAt) {
            entriesToDelete.push(fileId);
          }
        }

        for (const fileId of entriesToDelete) {
          urlCacheRef.current.delete(fileId);
          prefetchedIdsRef.current.delete(fileId);
        }
      },
      5 * 60 * 1000,
    ); // Clean up every 5 minutes

    return () => clearInterval(cleanupInterval);
  }, []);

  return { getCachedUrl, setCachedUrl };
}
