import Image from "next/image";
import React, { useState, memo, useMemo, useCallback, useRef } from "react";
import { useConvex, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { ImageViewer } from "./ImageViewer";
import { AlertCircle, File, Download } from "lucide-react";
import { FilePart, FilePartRendererProps } from "@/types/file";
import { toast } from "sonner";
import type { Id } from "@/convex/_generated/dataModel";

const FilePartRendererComponent = ({
  part,
  partIndex,
  messageId,
  totalFileParts = 1,
}: FilePartRendererProps) => {
  const convex = useConvex();
  const generateS3Urls = useAction(api.fileActions.generateS3DownloadUrlsAction);
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [downloadingFile, setDownloadingFile] = useState(false);

  // Cache for on-demand generated S3 URLs (per component instance)
  const s3UrlCacheRef = useRef<Map<string, string>>(new Map());

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
      console.log(`[FilePartRenderer] File click - fileName: ${fileName}, url type: ${typeof part.url}, url is null: ${part.url === null}, fileId: ${part.fileId}, storageId: ${part.storageId}, mediaType: ${part.mediaType}`);

      // If we have URL directly (string), use it
      if (typeof part.url === "string") {
        console.log(`[FilePartRenderer] Using existing URL (already fetched) - fileName: ${fileName}`);
        console.log(`[FilePartRenderer] URL preview: ${part.url.substring(0, 100)}...`);
        await handleDownload(part.url, fileName);
        return;
      }

      // OPTIMIZATION: For S3 files (fileId exists, url is null), generate URL on-demand
      if (part.fileId && part.url === null) {
        try {
          console.log(`[FilePartRenderer] On-demand S3 URL generation - fileId: ${part.fileId}, fileName: ${fileName}`);

          // Check cache first
          const cachedUrl = s3UrlCacheRef.current.get(part.fileId);
          if (cachedUrl) {
            console.log(`[FilePartRenderer] Using cached S3 URL - fileId: ${part.fileId}`);
            await handleDownload(cachedUrl, fileName);
            return;
          }

          console.log(`[FilePartRenderer] Fetching new S3 presigned URL - fileId: ${part.fileId}`);
          const results = await generateS3Urls({ fileIds: [part.fileId as Id<"files">] });

          if (results && results.length > 0 && results[0].url) {
            const downloadUrl = results[0].url;
            console.log(`[FilePartRenderer] Successfully generated S3 URL - fileId: ${part.fileId}`);

            // Cache the URL for future use (valid for 1 hour)
            s3UrlCacheRef.current.set(part.fileId, downloadUrl);

            await handleDownload(downloadUrl, fileName);
          } else {
            console.error(`[FilePartRenderer] Failed to get S3 download URL - fileId: ${part.fileId}`);
            toast.error("Failed to get download URL");
          }
        } catch (error) {
          console.error(`[FilePartRenderer] Error generating S3 download URL:`, error);
          toast.error("Failed to download file");
        }
        return;
      }

      // If we have storageId, fetch URL on-demand (Convex storage)
      if (part.storageId) {
        try {
          console.log(`[FilePartRenderer] On-demand Convex URL generation - storageId: ${part.storageId}, fileName: ${fileName}`);
          console.log(`[FilePartRenderer] Fetching Convex download URL...`);

          const downloadUrl = await convex.query(
            api.fileStorage.getFileDownloadUrl,
            { storageId: part.storageId },
          );

          if (downloadUrl) {
            console.log(`[FilePartRenderer] Successfully generated Convex URL - storageId: ${part.storageId}`);
            await handleDownload(downloadUrl, fileName);
          } else {
            console.error(`[FilePartRenderer] Failed to get Convex download URL - storageId: ${part.storageId}, URL is null or undefined`);
            toast.error("Failed to get download URL");
          }
        } catch (error) {
          console.error(`[FilePartRenderer] Error fetching Convex download URL:`, error);
          toast.error("Failed to download file");
        }
      }
    },
    [part.url, part.fileId, part.storageId, part.mediaType, convex, generateS3Urls, handleDownload],
  );

  // Memoize file preview component to prevent unnecessary re-renders
  const FilePreviewCard = useMemo(() => {
    const PreviewCard = ({
      partId,
      icon,
      fileName,
      subtitle,
      url,
      fileId,
      storageId,
    }: {
      partId: string;
      icon: React.ReactNode;
      fileName: string;
      subtitle: string;
      url?: string | null;
      fileId?: string;
      storageId?: string;
    }) => {
      // File is downloadable if: has URL string, OR has storageId (Convex), OR has fileId with null url (S3)
      const isDownloadable =
        (typeof url === "string") ||
        storageId ||
        (fileId && url === null);

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
          {isDownloadable && (
            <div className="flex items-center justify-center w-6 h-6 rounded-md border border-border opacity-0 group-hover:opacity-100 transition-opacity">
              <Download className="w-4 h-4 text-muted-foreground" />
            </div>
          )}
        </div>
      );

      if (isDownloadable) {
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
      // For images, we should have URL directly; for other files, we might have storageId or fileId
      const actualUrl = part.url;

      if (!actualUrl && !part.storageId && !part.fileId) {
        // Error state for files without URLs, storageId, or fileId
        return (
          <FilePreviewCard
            partId={partId}
            icon={<AlertCircle className="h-6 w-6 text-red-500" />}
            fileName={part.name || part.filename || "Unknown file"}
            subtitle="File not available"
            url={undefined}
            fileId={undefined}
            storageId={undefined}
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
              fileId={part.fileId}
              storageId={undefined}
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

      // Handle all non-image files with the new UI (use storageId or fileId)
      return (
        <FilePreviewCard
          partId={partId}
          icon={<File className="h-6 w-6 text-white" />}
          fileName={part.name || part.filename || "Document"}
          subtitle="Document"
          url={actualUrl}
          fileId={part.fileId}
          storageId={part.storageId}
        />
      );
    },
  );

  ConvexFilePart.displayName = "ConvexFilePart";

  // Memoize the rendered file part to prevent re-renders
  const renderedFilePart = useMemo(() => {
    const partId = `${messageId}-file-${partIndex}`;

    // Check if this is a file part with either URL, storageId, or fileId
    if (part.url || part.storageId || part.fileId) {
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
        fileId={part.fileId}
        storageId={part.storageId}
      />
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    messageId,
    partIndex,
    part.url,
    part.storageId,
    part.fileId,
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
      prevProps.part.name === nextProps.part.name &&
      prevProps.part.filename === nextProps.part.filename &&
      prevProps.part.mediaType === nextProps.part.mediaType
    );
  },
);
