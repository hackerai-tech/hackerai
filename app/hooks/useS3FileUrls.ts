import { useEffect, useState, useRef } from "react";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import type { ChatMessage } from "@/types";

/**
 * Hook to fetch S3 presigned URLs for file attachments in messages
 * Detects files with null URLs (S3-backed) and batch fetches presigned URLs
 */
export const useS3FileUrls = (messages: ChatMessage[]) => {
  const [urlCache, setUrlCache] = useState<Map<string, string>>(new Map());
  const generateS3Urls = useAction(
    api.fileActions.generateS3DownloadUrlsAction,
  );
  const pendingFetchRef = useRef<Set<string>>(new Set());

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

    if (fileIdsNeedingUrls.length === 0) return;

    // Batch fetch presigned URLs
    const fetchUrls = async () => {
      try {
        const results = await generateS3Urls({ fileIds: fileIdsNeedingUrls });

        setUrlCache((prev) => {
          const next = new Map(prev);
          for (const result of results) {
            next.set(result.fileId, result.url);
            pendingFetchRef.current.delete(result.fileId);
          }
          return next;
        });
      } catch (error) {
        console.error("Failed to fetch S3 URLs:", error);
        // Clear pending state on error so we can retry
        for (const fileId of fileIdsNeedingUrls) {
          pendingFetchRef.current.delete(fileId);
        }
      }
    };

    fetchUrls();
  }, [messages, urlCache, generateS3Urls]);

  // Enhance messages with cached URLs
  const enhancedMessages: ChatMessage[] = messages.map((message) => {
    if (!message.fileDetails) return message;

    const enhancedFileDetails = message.fileDetails.map((fileDetail) => {
      // If file has null URL and we have a cached URL, use it
      if (fileDetail.fileId && fileDetail.url === null) {
        const cachedUrl = urlCache.get(fileDetail.fileId);
        if (cachedUrl) {
          return { ...fileDetail, url: cachedUrl };
        }
      }
      return fileDetail;
    });

    return {
      ...message,
      fileDetails: enhancedFileDetails,
    };
  });

  return enhancedMessages;
};
