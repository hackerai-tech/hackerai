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
import {
  S3_URL_LIFETIME_SECONDS,
  S3_URL_EXPIRATION_BUFFER_SECONDS,
} from "@/lib/constants/s3";

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
    return timeUntilExpiry < S3_URL_EXPIRATION_BUFFER_SECONDS * 1000;
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
            const expiresAt = now + S3_URL_LIFETIME_SECONDS * 1000;
            next.set(result.fileId, {
              url: result.url,
              fetchedAt: now,
              expiresAt,
            });
            pendingFetchRef.current.delete(result.fileId);
            console.log(`[S3 Cache] Cached URL for ${result.fileId} (expires in ${S3_URL_LIFETIME_SECONDS / 60}m)`);
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
   * OPTIMIZATION: Only fetch URLs for IMAGE files on load
   * Non-image files will be fetched on-demand when user clicks download
   */
  useEffect(() => {
    // Collect all fileIds that need URLs (have null url and not already cached/pending)
    const fileIdsNeedingUrls: Array<Id<"files">> = [];
    let cacheMissCount = 0;

    for (const message of messages) {
      if (message.fileDetails) {
        for (const fileDetail of message.fileDetails) {
          // Check if this file has a null URL (S3-backed) and needs fetching
          // OPTIMIZATION: Only fetch URLs for images on page load
          const isImage = fileDetail.mediaType?.startsWith("image/");
          if (
            fileDetail.fileId &&
            fileDetail.url === null &&
            isImage &&
            !urlCache.has(fileDetail.fileId) &&
            !pendingFetchRef.current.has(fileDetail.fileId)
          ) {
            fileIdsNeedingUrls.push(fileDetail.fileId);
            pendingFetchRef.current.add(fileDetail.fileId);
            cacheMissCount++;
            console.log(`[S3 Cache] MISS (image) - fileId: ${fileDetail.fileId}`);
          }
        }
      }
    }

    if (fileIdsNeedingUrls.length > 0) {
      console.log(`[S3 Cache] Fetching URLs for ${cacheMissCount} uncached IMAGE files`);
      fetchUrls(fileIdsNeedingUrls);
    }
  }, [messages, urlCache, fetchUrls]);

  /**
   * Check for URLs that need refresh (in a useEffect to avoid side effects during render)
   * OPTIMIZATION: Only refresh URLs for IMAGE files (since we only cache them)
   */
  useEffect(() => {
    const idsToRefresh: Array<Id<"files">> = [];

    for (const message of messages) {
      if (message.fileDetails) {
        for (const fileDetail of message.fileDetails) {
          // OPTIMIZATION: Only check images (we only cache image URLs)
          const isImage = fileDetail.mediaType?.startsWith("image/");
          if (fileDetail.fileId && fileDetail.url === null && isImage) {
            const cached = urlCache.get(fileDetail.fileId);
            if (cached && needsRefresh(cached)) {
              if (!pendingFetchRef.current.has(fileDetail.fileId)) {
                const timeUntilExpiry = cached.expiresAt - Date.now();
                const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
                console.log(`[S3 Cache] REFRESH needed (image) - fileId: ${fileDetail.fileId}, expires in ${minutesUntilExpiry}m`);
                idsToRefresh.push(fileDetail.fileId);
                pendingFetchRef.current.add(fileDetail.fileId);
              }
            }
          }
        }
      }
    }

    if (idsToRefresh.length > 0) {
      console.log(`[S3 Cache] Refreshing ${idsToRefresh.length} expiring IMAGE URLs from messages`);
      fetchUrls(idsToRefresh);
    }
  }, [messages, urlCache, needsRefresh, fetchUrls]);

  /**
   * Enhance messages with cached URLs
   * OPTIMIZATION: Only enhance IMAGE files (we only cache image URLs)
   * Non-image files keep url: null and will be fetched on-demand when clicked
   *
   * Processes BOTH message.fileDetails (assistant messages) AND message.parts (user messages)
   */
  const enhancedMessages: ChatMessage[] = useMemo(() => {
    let cacheHitCount = 0;
    let cacheMissCount = 0;
    let totalS3Images = 0;

    const result = messages.map((message) => {
      // Process fileDetails (assistant messages)
      const enhancedFileDetails = message.fileDetails?.map((fileDetail) => {
        // OPTIMIZATION: Only enhance images (we only cache image URLs)
        const isImage = fileDetail.mediaType?.startsWith("image/");

        console.log(`[S3 Cache] Processing fileDetail - fileId: ${fileDetail.fileId}, name: ${fileDetail.name}, mediaType: "${fileDetail.mediaType}", isImage: ${isImage}, url type: ${typeof fileDetail.url}, url is null: ${fileDetail.url === null}`);

        // If file has null URL and is an image, check cache
        if (fileDetail.fileId && fileDetail.url === null && isImage) {
          totalS3Images++;
          const cached = urlCache.get(fileDetail.fileId);
          if (cached) {
            cacheHitCount++;
            const timeUntilExpiry = cached.expiresAt - Date.now();
            const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
            console.log(`[S3 Cache] HIT (image) - fileId: ${fileDetail.fileId}, expires in ${minutesUntilExpiry}m`);
            return { ...fileDetail, url: cached.url };
          } else {
            cacheMissCount++;
            // Miss will be logged in the fetch effect
          }
        }

        // For non-images with null URL, keep url: null (will be fetched on-demand)
        if (fileDetail.fileId && fileDetail.url === null && !isImage) {
          console.log(`[S3 Cache] SKIP fileDetail (non-image) - fileId: ${fileDetail.fileId}, name: ${fileDetail.name}, keeping url: null for lazy loading`);
        }

        return fileDetail;
      });

      // Process parts (user messages)
      // OPTIMIZATION: Set non-image file URLs to null for lazy loading
      const enhancedParts = message.parts.map((part): any => {
        if (part.type === "file") {
          const filePart = part as any; // Type assertion for extended file part with fileId
          const isImage = filePart.mediaType?.startsWith("image/");

          console.log(`[S3 Cache] Processing part - fileId: ${filePart.fileId}, name: ${filePart.name}, mediaType: "${filePart.mediaType}", isImage: ${isImage}, url type: ${typeof filePart.url}`);

          // For S3 files with fileId
          if (filePart.fileId) {
            // Images: fetch from cache
            if (isImage && filePart.url) {
              totalS3Images++;
              const cached = urlCache.get(filePart.fileId);
              if (cached) {
                cacheHitCount++;
                const timeUntilExpiry = cached.expiresAt - Date.now();
                const minutesUntilExpiry = Math.floor(timeUntilExpiry / 60000);
                console.log(`[S3 Cache] HIT part (image) - fileId: ${filePart.fileId}, expires in ${minutesUntilExpiry}m`);
                return { ...filePart, url: cached.url };
              } else {
                cacheMissCount++;
                console.log(`[S3 Cache] MISS part (image) - fileId: ${filePart.fileId}, setting url to null for fetch`);
                return { ...filePart, url: null };
              }
            }

            // Non-images: set URL to null for lazy loading
            if (!isImage && filePart.url) {
              console.log(`[S3 Cache] Setting part URL to null (non-image) - fileId: ${filePart.fileId}, name: ${filePart.name}, for lazy loading`);
              return { ...filePart, url: null };
            }
          }
        }
        return part;
      });

      return {
        ...message,
        parts: enhancedParts as any,
        fileDetails: enhancedFileDetails,
      };
    });

    if (totalS3Images > 0) {
      const hitRate = ((cacheHitCount / totalS3Images) * 100).toFixed(1);
      console.log(`[S3 Cache] Stats - Total S3 Images: ${totalS3Images}, Hits: ${cacheHitCount}, Misses: ${cacheMissCount}, Hit Rate: ${hitRate}%`);
    }

    return result as ChatMessage[];
  }, [messages, urlCache]);

  return enhancedMessages;
};
