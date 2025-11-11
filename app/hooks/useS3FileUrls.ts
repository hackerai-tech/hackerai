/**
 * Hook to fetch and manage S3 presigned URLs for file attachments
 *
 * Features:
 * - Batch fetching of presigned URLs for efficiency
 * - Client-side caching with expiration tracking
 * - Automatic URL refresh before expiration
 * - Handles null URLs (S3-backed files)
 *
 * @module app/hooks/useS3FileUrls
 */

import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ChatMessage } from "@/types";

// URL expiration buffer: refresh URLs this many seconds before they expire
const URL_EXPIRATION_BUFFER_SECONDS = 300; // 5 minutes

// S3 presigned URLs expire after this many seconds (must match server setting)
const URL_LIFETIME_SECONDS = 3600; // 1 hour

interface CachedUrl {
  url: string;
  fetchedAt: number; // Unix timestamp in milliseconds
  expiresAt: number; // Unix timestamp in milliseconds
}

/**
 * Hook to fetch S3 presigned URLs for file attachments in messages
 * Detects files with null URLs (S3-backed) and batch fetches presigned URLs
 * Automatically refreshes URLs before they expire
 */
export const useS3FileUrls = (messages: ChatMessage[]) => {
  const [urlCache, setUrlCache] = useState<Map<string, CachedUrl>>(new Map());
  const generateS3Urls = useAction(
    api.fileActions.generateS3DownloadUrlsAction,
  );
  const pendingFetchRef = useRef<Set<string>>(new Set());
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  /**
   * Check if a cached URL needs refresh
   */
  const needsRefresh = useCallback((cached: CachedUrl): boolean => {
    const now = Date.now();
    const timeUntilExpiry = cached.expiresAt - now;
    return timeUntilExpiry < URL_EXPIRATION_BUFFER_SECONDS * 1000;
  }, []);

  /**
   * Fetch presigned URLs for given file IDs
   */
  const fetchUrls = useCallback(
    async (fileIds: Array<Id<"files">>) => {
      if (fileIds.length === 0) return;

      try {
        console.log(`[S3 Cache] Fetching URLs for ${fileIds.length} files - fileIds: [${fileIds.join(", ")}]`);
        const fetchStartTime = Date.now();
        const results = await generateS3Urls({ fileIds });
        const fetchDuration = Date.now() - fetchStartTime;
        const now = Date.now();

        console.log(`[S3 Cache] Fetch complete - ${results.length} URLs fetched in ${fetchDuration}ms`);

        setUrlCache((prev) => {
          const next = new Map(prev);
          for (const result of results) {
            const expiresAt = now + URL_LIFETIME_SECONDS * 1000;
            next.set(result.fileId, {
              url: result.url,
              fetchedAt: now,
              expiresAt,
            });
            pendingFetchRef.current.delete(result.fileId);
            console.log(`[S3 Cache] Cached URL for ${result.fileId} (expires in ${URL_LIFETIME_SECONDS / 60}m)`);
          }
          console.log(`[S3 Cache] Cache size: ${next.size} URLs`);
          return next;
        });

        console.log(`[S3 Cache] Successfully cached ${results.length} URLs`);
      } catch (error) {
        console.error("[S3 Cache] Failed to fetch URLs:", error);
        // Clear pending state on error so we can retry
        for (const fileId of fileIds) {
          pendingFetchRef.current.delete(fileId);
        }
      }
    },
    [generateS3Urls],
  );

  /**
   * Check for expired or expiring URLs and refresh them
   */
  const refreshExpiredUrls = useCallback(() => {
    const idsToRefresh: Array<Id<"files">> = [];

    for (const [fileId, cached] of urlCache.entries()) {
      if (needsRefresh(cached) && !pendingFetchRef.current.has(fileId)) {
        const timeUntilExpiry = cached.expiresAt - Date.now();
        const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
        console.log(`[S3 Cache] REFRESH (periodic) - fileId: ${fileId}, expires in ${minutesUntilExpiry}m`);
        idsToRefresh.push(fileId as Id<"files">);
        pendingFetchRef.current.add(fileId);
      }
    }

    if (idsToRefresh.length > 0) {
      console.log(`[S3 Cache] Periodic refresh - ${idsToRefresh.length} URLs expiring soon`);
      fetchUrls(idsToRefresh);
    }
  }, [urlCache, needsRefresh, fetchUrls]);

  /**
   * Set up periodic check for expiring URLs
   */
  useEffect(() => {
    // Check every minute for expiring URLs
    refreshTimerRef.current = setInterval(() => {
      refreshExpiredUrls();
    }, 60 * 1000);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [refreshExpiredUrls]);

  /**
   * Fetch URLs for new files that need them
   */
  useEffect(() => {
    // Collect all fileIds that need URLs (have null url and not already cached/pending)
    const fileIdsNeedingUrls: Array<Id<"files">> = [];
    let cacheMissCount = 0;

    for (const message of messages) {
      if (message.fileDetails) {
        for (const fileDetail of message.fileDetails) {
          // Check if this file has a null URL (S3-backed) and needs fetching
          if (
            fileDetail.fileId &&
            fileDetail.url === null &&
            !urlCache.has(fileDetail.fileId) &&
            !pendingFetchRef.current.has(fileDetail.fileId)
          ) {
            fileIdsNeedingUrls.push(fileDetail.fileId);
            pendingFetchRef.current.add(fileDetail.fileId);
            cacheMissCount++;
            console.log(`[S3 Cache] MISS - fileId: ${fileDetail.fileId}`);
          }
        }
      }
    }

    if (fileIdsNeedingUrls.length > 0) {
      console.log(`[S3 Cache] Fetching URLs for ${cacheMissCount} uncached files`);
      fetchUrls(fileIdsNeedingUrls);
    }
  }, [messages, urlCache, fetchUrls]);

  /**
   * Check for URLs that need refresh (in a useEffect to avoid side effects during render)
   */
  useEffect(() => {
    const idsToRefresh: Array<Id<"files">> = [];

    for (const message of messages) {
      if (message.fileDetails) {
        for (const fileDetail of message.fileDetails) {
          if (fileDetail.fileId && fileDetail.url === null) {
            const cached = urlCache.get(fileDetail.fileId);
            if (cached && needsRefresh(cached)) {
              if (!pendingFetchRef.current.has(fileDetail.fileId)) {
                const timeUntilExpiry = cached.expiresAt - Date.now();
                const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
                console.log(`[S3 Cache] REFRESH needed - fileId: ${fileDetail.fileId}, expires in ${minutesUntilExpiry}m`);
                idsToRefresh.push(fileDetail.fileId);
                pendingFetchRef.current.add(fileDetail.fileId);
              }
            }
          }
        }
      }
    }

    if (idsToRefresh.length > 0) {
      console.log(`[S3 Cache] Refreshing ${idsToRefresh.length} expiring URLs from messages`);
      fetchUrls(idsToRefresh);
    }
  }, [messages, urlCache, needsRefresh, fetchUrls]);

  /**
   * Enhance messages with cached URLs
   */
  const enhancedMessages: ChatMessage[] = useMemo(() => {
    let cacheHitCount = 0;
    let cacheMissCount = 0;
    let totalS3Files = 0;

    const result = messages.map((message) => {
      if (!message.fileDetails) return message;

      const enhancedFileDetails = message.fileDetails.map((fileDetail) => {
        // If file has null URL and we have a cached URL, use it
        if (fileDetail.fileId && fileDetail.url === null) {
          totalS3Files++;
          const cached = urlCache.get(fileDetail.fileId);
          if (cached) {
            cacheHitCount++;
            const timeUntilExpiry = cached.expiresAt - Date.now();
            const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
            console.log(`[S3 Cache] HIT - fileId: ${fileDetail.fileId}, expires in ${minutesUntilExpiry}m`);
            return { ...fileDetail, url: cached.url };
          } else {
            cacheMissCount++;
            // Miss will be logged in the fetch effect
          }
        }
        return fileDetail;
      });

      return {
        ...message,
        fileDetails: enhancedFileDetails,
      };
    });

    if (totalS3Files > 0) {
      const hitRate = ((cacheHitCount / totalS3Files) * 100).toFixed(1);
      console.log(`[S3 Cache] Stats - Total: ${totalS3Files}, Hits: ${cacheHitCount}, Misses: ${cacheMissCount}, Hit Rate: ${hitRate}%`);
    }

    return result;
  }, [messages, urlCache]);

  return enhancedMessages;
};
