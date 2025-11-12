import Image from "next/image";
import React, { useState, memo, useMemo, useCallback, useEffect } from "react";
import { useConvex, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ImageViewer } from "./ImageViewer";
import { AlertCircle, File, Download, Loader2 } from "lucide-react";
import { FilePart, FilePartRendererProps } from "@/types/file";
import { toast } from "sonner";
import { useFileUrlCacheContext } from "../contexts/FileUrlCacheContext";
import { isSupportedImageMediaType } from "@/lib/utils/file-utils";

const FilePartRendererComponent = ({
  part,
  partIndex,
  messageId,
  totalFileParts = 1,
}: FilePartRendererProps) => {
  const convex = useConvex();
  const getFileUrlAction = useAction(api.s3Actions.getFileUrlAction);
  const fileUrlCache = useFileUrlCacheContext();
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [downloadingFile, setDownloadingFile] = useState(false);
  const [fileUrl, setFileUrl] = useState<string | null>(null);
  const [isLoadingUrl, setIsLoadingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);

  // Fetch URL ONLY for images (inline display) - non-images are fetched lazily on click
  useEffect(() => {
    async function fetchUrl() {
      // If we already have a URL directly, use it
      if (part.url) {
        setFileUrl(part.url);
        return;
      }

      // Only fetch URLs eagerly for images (they display inline)
      // Non-images will be fetched lazily when user clicks download button
      const isImage = part.mediaType?.startsWith("image/");
      if (!isImage) {
        return;
      }

      // If we have fileId (for S3 files), check cache first
      if (part.fileId) {
        if (fileUrlCache) {
          const cachedUrl = fileUrlCache.getCachedUrl(part.fileId);
          if (cachedUrl) {
            setFileUrl(cachedUrl);
            return;
          }
        }

        // Not in cache, fetch URL for image
        setIsLoadingUrl(true);
        setUrlError(null);
        try {
          const url = await getFileUrlAction({ fileId: part.fileId });
          setFileUrl(url);
          // Cache the fetched URL
          if (fileUrlCache) {
            fileUrlCache.setCachedUrl(part.fileId, url);
          }
        } catch (error) {
          console.error("Failed to fetch file URL:", error);
          setUrlError("Failed to load file");
        } finally {
          setIsLoadingUrl(false);
        }
        return;
      }

      // If we have storageId (for Convex files), fetch URL on-demand for images
      if (part.storageId) {
        setIsLoadingUrl(true);
        setUrlError(null);
        try {
          const url = await convex.query(api.fileStorage.getFileDownloadUrl, {
            storageId: part.storageId,
          });
          if (url) {
            setFileUrl(url);
          } else {
            setUrlError("Failed to get download URL");
          }
        } catch (error) {
          console.error("Failed to fetch download URL:", error);
          setUrlError("Failed to load file");
        } finally {
          setIsLoadingUrl(false);
        }
        return;
      }
    }

    fetchUrl();
  }, [
    part.url,
    part.fileId,
    part.storageId,
    part.mediaType,
    getFileUrlAction,
    convex,
    fileUrlCache,
  ]);

  const handleDownload = useCallback(async (url: string, fileName: string) => {
    try {
      setDownloadingFile(true);
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);

      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      URL.revokeObjectURL(blobUrl);
    } catch (error) {
      console.error("Error downloading file:", error);
      toast.error("Failed to download file");
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloadingFile(false);
    }
  }, []);

  const handleNonImageFileClick = useCallback(
    async (fileName: string) => {
      // Check if we already have the URL cached or in state
      if (fileUrl) {
        await handleDownload(fileUrl, fileName);
        return;
      }

      // Check cache first
      if (fileUrlCache && part.fileId) {
        const cachedUrl = fileUrlCache.getCachedUrl(part.fileId);
        if (cachedUrl) {
          await handleDownload(cachedUrl, fileName);
          return;
        }
      }

      // Fetch URL lazily on click
      setIsLoadingUrl(true);
      try {
        let url: string | null = null;

        if (part.fileId) {
          // S3 file - fetch presigned URL
          url = await getFileUrlAction({ fileId: part.fileId });

          // Cache it for future clicks
          if (url && fileUrlCache) {
            fileUrlCache.setCachedUrl(part.fileId, url);
          }
        } else if (part.storageId) {
          // Convex storage file - fetch URL
          url = await convex.query(api.fileStorage.getFileDownloadUrl, {
            storageId: part.storageId,
          });
        }

        if (url) {
          setFileUrl(url);
          await handleDownload(url, fileName);
        } else {
          toast.error("Failed to get download URL");
        }
      } catch (error) {
        console.error("Failed to fetch download URL:", error);
        toast.error("Failed to fetch download URL");
      } finally {
        setIsLoadingUrl(false);
      }
    },
    [fileUrl, handleDownload, part.fileId, part.storageId, fileUrlCache, getFileUrlAction, convex],
  );

  // Memoize file preview component to prevent unnecessary re-renders
  const FilePreviewCard = useMemo(() => {
    const PreviewCard = ({
      partId,
      icon,
      fileName,
      subtitle,
      url,
      storageId,
      fileId,
    }: {
      partId: string;
      icon: React.ReactNode;
      fileName: string;
      subtitle: string;
      url?: string;
      storageId?: string;
      fileId?: string;
    }) => {
      const content = (
        <div className="flex flex-row items-center gap-2">
          <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-[#FF5588] flex items-center justify-center">
            {icon}
          </div>
          <div className="overflow-hidden flex-1">
            <div className="truncate font-semibold text-sm text-left">
              {fileName}
            </div>
            <div className="text-muted-foreground truncate text-xs text-left">
              {subtitle}
            </div>
          </div>
          {(url || storageId || fileId) && (
            <div className="flex items-center justify-center w-6 h-6 rounded-md border border-border opacity-0 group-hover:opacity-100 transition-opacity">
              <Download className="w-4 h-4 text-muted-foreground" />
            </div>
          )}
        </div>
      );

      if (url || storageId || fileId) {
        return (
          <button
            key={partId}
            onClick={() => handleNonImageFileClick(fileName)}
            disabled={downloadingFile}
            className="group p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background hover:bg-secondary transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
            type="button"
            aria-label={`Download ${fileName}`}
          >
            {content}
          </button>
        );
      }

      return (
        <div
          key={partId}
          className="p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background"
        >
          {content}
        </div>
      );
    };
    PreviewCard.displayName = "FilePreviewCard";
    return PreviewCard;
  }, [handleNonImageFileClick, downloadingFile]);

  // Memoize ConvexFilePart to prevent unnecessary re-renders
  const ConvexFilePart = memo(
    ({ part, partId }: { part: FilePart; partId: string }) => {
      // Show loading state while fetching URL
      if (isLoadingUrl) {
        return (
          <div className="p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background flex items-center justify-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
            <span className="text-sm text-muted-foreground">Loading...</span>
          </div>
        );
      }

      // Show error state if URL fetch failed
      if (urlError) {
        return (
          <FilePreviewCard
            partId={partId}
            icon={<AlertCircle className="h-6 w-6 text-red-500" />}
            fileName={part.name || part.filename || "Unknown file"}
            subtitle={urlError}
            url={undefined}
            storageId={undefined}
            fileId={undefined}
          />
        );
      }

      // Use the fetched URL or the URL from props
      const actualUrl = fileUrl || part.url;

      if (!actualUrl && !part.storageId && !part.fileId) {
        // Error state for files without URLs or storage references
        return (
          <FilePreviewCard
            partId={partId}
            icon={<AlertCircle className="h-6 w-6 text-red-500" />}
            fileName={part.name || part.filename || "Unknown file"}
            subtitle="File not available"
            url={undefined}
            storageId={undefined}
            fileId={undefined}
          />
        );
      }

      // Handle image files - they should always have URL
      if (part.mediaType?.startsWith("image/")) {
        if (!actualUrl) {
          return (
            <FilePreviewCard
              partId={partId}
              icon={<AlertCircle className="h-6 w-6 text-red-500" />}
              fileName={part.name || part.filename || "Unknown image"}
              subtitle="Image URL not available"
              url={undefined}
              storageId={undefined}
              fileId={undefined}
            />
          );
        }

        const altText = part.name || `Uploaded image ${partIndex + 1}`;
        const isMultipleImages = totalFileParts > 1;

        // Different styling for single vs multiple images
        const containerClass = isMultipleImages
          ? "overflow-hidden rounded-lg"
          : "overflow-hidden rounded-lg max-w-64";

        const innerContainerClass = isMultipleImages
          ? "bg-token-main-surface-secondary text-token-text-tertiary relative flex items-center justify-center overflow-hidden"
          : "bg-token-main-surface-secondary text-token-text-tertiary relative flex items-center justify-center overflow-hidden";

        const buttonClass = isMultipleImages
          ? "overflow-hidden rounded-lg"
          : "overflow-hidden rounded-lg w-full";

        const imageClass = isMultipleImages
          ? "aspect-square object-cover object-center h-32 w-32 rounded-se-2xl rounded-ee-sm overflow-hidden transition-opacity duration-300 opacity-100"
          : "w-full h-auto max-h-96 max-w-64 object-contain rounded-lg transition-opacity duration-300 opacity-100";

        return (
          <div key={partId} className={containerClass}>
            <div className={innerContainerClass}>
              <button
                onClick={() =>
                  setSelectedImage({ src: actualUrl, alt: altText })
                }
                className={buttonClass}
                aria-label={`View ${altText} in full size`}
                type="button"
              >
                <Image
                  src={actualUrl}
                  alt={altText}
                  width={902}
                  height={2048}
                  className={imageClass}
                  style={{ maxWidth: "100%", height: "auto" }}
                />
              </button>
            </div>
          </div>
        );
      }

      // Handle all non-image files with the new UI (use storageId or fileId if no URL)
      return (
        <FilePreviewCard
          partId={partId}
          icon={<File className="h-6 w-6 text-white" />}
          fileName={part.name || part.filename || "Document"}
          subtitle="Document"
          url={actualUrl}
          storageId={part.storageId}
          fileId={part.fileId}
        />
      );
    },
  );

  ConvexFilePart.displayName = "ConvexFilePart";

  // Memoize the rendered file part to prevent re-renders
  const renderedFilePart = useMemo(() => {
    const partId = `${messageId}-file-${partIndex}`;

    // Check if this is a file part with either URL, storageId, or fileId
    if (part.url || part.storageId || part.fileId || fileUrl) {
      return <ConvexFilePart part={part} partId={partId} />;
    }

    // Fallback for unsupported file types
    return (
      <FilePreviewCard
        partId={partId}
        icon={<File className="h-6 w-6 text-white" />}
        fileName={part.name || part.filename || "Unknown file"}
        subtitle="Document"
        url={part.url}
        storageId={part.storageId}
        fileId={part.fileId}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messageId,
    partIndex,
    part.url,
    part.storageId,
    part.fileId,
    fileUrl,
    isLoadingUrl,
    urlError,
    FilePreviewCard,
  ]);

  return (
    <>
      {renderedFilePart}
      {/* Image Viewer Modal */}
      {selectedImage && (
        <ImageViewer
          isOpen={!!selectedImage}
          onClose={() => setSelectedImage(null)}
          imageSrc={selectedImage.src}
          imageAlt={selectedImage.alt}
        />
      )}
    </>
  );
};

// Memoize the entire component to prevent unnecessary re-renders during streaming
export const FilePartRenderer = memo(
  FilePartRendererComponent,
  (prevProps, nextProps) => {
    // Custom comparison to prevent re-renders when props haven't meaningfully changed
    return (
      prevProps.messageId === nextProps.messageId &&
      prevProps.partIndex === nextProps.partIndex &&
      prevProps.totalFileParts === nextProps.totalFileParts &&
      prevProps.part.url === nextProps.part.url &&
      prevProps.part.storageId === nextProps.part.storageId &&
      prevProps.part.fileId === nextProps.part.fileId &&
      prevProps.part.s3Key === nextProps.part.s3Key &&
      prevProps.part.name === nextProps.part.name &&
      prevProps.part.filename === nextProps.part.filename &&
      prevProps.part.mediaType === nextProps.part.mediaType
    );
  },
);
