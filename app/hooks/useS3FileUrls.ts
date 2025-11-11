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
        console.log(`[S3] Fetching URLs for ${fileIds.length} files`);
        const results = await generateS3Urls({ fileIds });
        const now = Date.now();

        setUrlCache((prev) => {
          const next = new Map(prev);
          for (const result of results) {
            next.set(result.fileId, {
              url: result.url,
              fetchedAt: now,
              expiresAt: now + URL_LIFETIME_SECONDS * 1000,
            });
            pendingFetchRef.current.delete(result.fileId);
          }
          return next;
        });

        console.log(`[S3] Successfully cached ${results.length} URLs`);
      } catch (error) {
        console.error("[S3] Failed to fetch URLs:", error);
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
        idsToRefresh.push(fileId as Id<"files">);
        pendingFetchRef.current.add(fileId);
      }
    }

    if (idsToRefresh.length > 0) {
      console.log(`[S3] Refreshing ${idsToRefresh.length} expiring URLs`);
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
          }
        }
      }
    }

    if (fileIdsNeedingUrls.length > 0) {
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
                idsToRefresh.push(fileDetail.fileId);
                pendingFetchRef.current.add(fileDetail.fileId);
              }
            }
          }
        }
      }
    }

    if (idsToRefresh.length > 0) {
      console.log(`[S3] Refreshing ${idsToRefresh.length} expiring URLs from messages`);
      fetchUrls(idsToRefresh);
    }
  }, [messages, urlCache, needsRefresh, fetchUrls]);

  /**
   * Enhance messages with cached URLs
   */
  const enhancedMessages: ChatMessage[] = useMemo(() => {
    return messages.map((message) => {
      if (!message.fileDetails) return message;

      const enhancedFileDetails = message.fileDetails.map((fileDetail) => {
        // If file has null URL and we have a cached URL, use it
        if (fileDetail.fileId && fileDetail.url === null) {
          const cached = urlCache.get(fileDetail.fileId);
          if (cached) {
            return { ...fileDetail, url: cached.url };
          }
        }
        return fileDetail;
      });

      return {
        ...message,
        fileDetails: enhancedFileDetails,
      };
    });
  }, [messages, urlCache]);

  return enhancedMessages;
};
