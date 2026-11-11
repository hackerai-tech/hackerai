import { useCallback, useRef, useState } from "react";
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { toast } from "sonner";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useFileUrlCacheContext } from "@/app/contexts/FileUrlCacheContext";
import { isTauriEnvironment, openDownloadsFolder } from "./useTauri";
import { startBlobDownload } from "@/lib/utils/file-download";

export type AttachmentDownloadOutcome =
  "downloaded" | "opened-fallback" | "unavailable" | "failed" | "busy";

interface AttachmentDownloadRequest {
  fileId?: Id<"files">;
  /** Direct URL for transient attachments without a stored file ID. */
  url?: string;
  fileName: string;
}

/**
 * Download one stored attachment. A file ID always resolves a fresh
 * authenticated URL unless the shared cache still holds an unexpired one.
 * Failures leave the caller's control usable so the user can retry.
 */
export function useAttachmentDownload() {
  const getFileUrlAction = useAction(api.s3Actions.getFileUrlAction);
  const fileUrlCache = useFileUrlCacheContext();
  const inFlightRef = useRef(false);
  const [isDownloading, setIsDownloading] = useState(false);

  const downloadFromUrl = useCallback(
    async (
      url: string,
      fileName: string,
    ): Promise<AttachmentDownloadOutcome> => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error("File download request failed");
        const blob = await response.blob();
        startBlobDownload(blob, fileName);

        if (isTauriEnvironment()) {
          toast.success(`Downloaded ${fileName}`, {
            description: "Saved to Downloads folder",
            action: {
              label: "Show in folder",
              onClick: () => openDownloadsFolder(),
            },
          });
        }
        return "downloaded";
      } catch (error) {
        console.error("Error downloading file:", error);
        toast.error("Failed to download file");
        window.open(url, "_blank", "noopener,noreferrer");
        return "opened-fallback";
      }
    },
    [],
  );

  const downloadAttachment = useCallback(
    async ({
      fileId,
      url: directUrl,
      fileName,
    }: AttachmentDownloadRequest): Promise<AttachmentDownloadOutcome> => {
      if (inFlightRef.current) return "busy";
      inFlightRef.current = true;
      setIsDownloading(true);
      try {
        // Recheck expiry on every click; component state can outlive a signed URL.
        const cachedUrl =
          fileId && fileUrlCache ? fileUrlCache.getCachedUrl(fileId) : null;
        if (cachedUrl) return await downloadFromUrl(cachedUrl, fileName);

        let url: string | null = null;
        try {
          if (fileId) {
            url = await getFileUrlAction({ fileId });
            if (url && fileUrlCache) fileUrlCache.setCachedUrl(fileId, url);
          } else if (directUrl) {
            url = directUrl;
          }
        } catch (error) {
          console.error("Failed to fetch download URL:", error);
          const errorMessage =
            error instanceof ConvexError
              ? (error.data as { message?: string })?.message ||
                error.message ||
                "Failed to fetch download URL"
              : error instanceof Error
                ? error.message
                : "Failed to fetch download URL";
          toast.error(errorMessage);
          return "failed";
        }

        if (!url) {
          toast.error("Failed to get download URL");
          return "unavailable";
        }
        return await downloadFromUrl(url, fileName);
      } finally {
        inFlightRef.current = false;
        setIsDownloading(false);
      }
    },
    [downloadFromUrl, fileUrlCache, getFileUrlAction],
  );

  return { downloadAttachment, isDownloading };
}
