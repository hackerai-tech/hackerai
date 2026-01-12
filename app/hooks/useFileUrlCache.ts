import { useEffect, useRef, useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { isSupportedImageMediaType } from "@/lib/utils/file-utils";
import type { ChatMessage } from "@/types";

interface CachedUrl {
  url: string;
  timestamp: number;
}

const URL_CACHE_EXPIRATION = 50 * 60 * 1000; // 50 minutes (S3 URLs expire in 1 hour)

/**
 * Hook to manage prefetching and caching of file URLs
 *
 * Features:
 * - Batch prefetches URLs for all S3 image files in messages (images need eager loading)
 * - Caches URLs with expiration handling (50 min, before 1 hour S3 expiry)
 * - Provides methods to get and set cached URLs (for lazy-loaded non-image files)
 * - Automatically cleans up expired URLs
 */
export function useFileUrlCache(messages: ChatMessage[]) {
  const getFileUrlsBatchAction = useAction(
    api.s3Actions.getFileUrlsBatchAction,
  );
  const urlCacheRef = useRef<Map<string, CachedUrl>>(new Map());
  const prefetchedIdsRef = useRef<Set<string>>(new Set());

  // Get cached URL for a file (returns null if expired or not cached)
  const getCachedUrl = useCallback((fileId: string): string | null => {
    const cached = urlCacheRef.current.get(fileId);
    if (!cached) return null;

    // Check if URL has expired
    const now = Date.now();
    if (now - cached.timestamp > URL_CACHE_EXPIRATION) {
      urlCacheRef.current.delete(fileId);
      prefetchedIdsRef.current.delete(fileId);
      return null;
    }

    return cached.url;
  }, []);

  // Set/update cached URL for a file (used for lazy-loaded non-image files)
  const setCachedUrl = useCallback((fileId: string, url: string) => {
    const now = Date.now();
    urlCacheRef.current.set(fileId, { url, timestamp: now });
    prefetchedIdsRef.current.add(fileId);
  }, []);

  // Prefetch image URLs for messages
  useEffect(() => {
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
          // 1. Have an S3 key (not Convex storage)
          // 2. Are supported image types
          // 3. Haven't been prefetched yet
          // 4. Haven't been seen in this run
          if (
            file.s3Key &&
            file.mediaType &&
            isSupportedImageMediaType(file.mediaType) &&
            !prefetchedIdsRef.current.has(file.fileId) &&
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

      // Batch fetch URLs with deduplicated fileIds
      try {
        const fileIds = s3ImageFiles.map((f) => f.fileId);
        const urlMap = await getFileUrlsBatchAction({ fileIds });

        // Cache the fetched URLs (only if urlMap is valid)
        if (urlMap && typeof urlMap === "object") {
          const now = Date.now();
          for (const [fileId, url] of Object.entries(urlMap) as Array<
            [string, string]
          >) {
            urlCacheRef.current.set(fileId, { url, timestamp: now });
            prefetchedIdsRef.current.add(fileId);
          }
        }
      } catch (error) {
        console.error("Failed to prefetch image URLs:", error);
      }
    }

    prefetchImageUrls();
  }, [messages, getFileUrlsBatchAction]);

  // Cleanup expired URLs periodically
  useEffect(() => {
    const cleanupInterval = setInterval(
      () => {
        const now = Date.now();
        const entriesToDelete: string[] = [];

        for (const [fileId, cached] of urlCacheRef.current.entries()) {
          if (now - cached.timestamp > URL_CACHE_EXPIRATION) {
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
