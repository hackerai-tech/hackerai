import Image from "next/image";
import React, { useState, memo, useMemo, useCallback } from "react";
import { ImageViewer } from "./ImageViewer";
import { AlertCircle, File, Download } from "lucide-react";
import { FilePart, FilePartRendererProps } from "@/types/file";

const FilePartRendererComponent = ({
  part,
  partIndex,
  messageId,
  totalFileParts = 1,
}: FilePartRendererProps) => {
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  const handleDownload = useCallback(async (url: string, fileName: string) => {
    try {
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
      window.open(url, "_blank", "noopener,noreferrer");
    }
  }, []);

  // Memoize file preview component to prevent unnecessary re-renders
  const FilePreviewCard = useMemo(() => {
    const PreviewCard = ({
      partId,
      icon,
      fileName,
      subtitle,
      url,
    }: {
      partId: string;
      icon: React.ReactNode;
      fileName: string;
      subtitle: string;
      url?: string;
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
          {url && (
            <div className="flex items-center justify-center w-6 h-6 rounded-md border border-border opacity-0 group-hover:opacity-100 transition-opacity">
              <Download className="w-4 h-4 text-muted-foreground" />
            </div>
          )}
        </div>
      );

      if (url) {
        return (
          <button
            key={partId}
            onClick={() => handleDownload(url, fileName)}
            className="group p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background hover:bg-secondary transition-colors cursor-pointer"
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
  }, [handleDownload]);

  // Memoize ConvexFilePart to prevent unnecessary re-renders
  const ConvexFilePart = memo(
    ({ part, partId }: { part: FilePart; partId: string }) => {
      // All new files should have URLs directly available
      const actualUrl = part.url;

      if (!actualUrl) {
        // Error state for files without URLs
        return (
          <FilePreviewCard
            partId={partId}
            icon={<AlertCircle className="h-6 w-6 text-red-500" />}
            fileName={part.name || part.filename || "Unknown file"}
            subtitle="File URL not available"
            url={undefined}
          />
        );
      }

      // Handle image files
      if (part.mediaType?.startsWith("image/")) {
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

      // Handle all non-image files with the new UI
      return (
        <FilePreviewCard
          partId={partId}
          icon={<File className="h-6 w-6 text-white" />}
          fileName={part.name || part.filename || "Document"}
          subtitle="Document"
          url={actualUrl}
        />
      );
    },
  );

  ConvexFilePart.displayName = "ConvexFilePart";

  // Memoize the rendered file part to prevent re-renders
  const renderedFilePart = useMemo(() => {
    const partId = `${messageId}-file-${partIndex}`;

    // Check if this is a file part with either URL or fileId
    if (part.url || part.fileId) {
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
      />
    );
  }, [messageId, partIndex, part.url, part.fileId, FilePreviewCard]);

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
      prevProps.part.fileId === nextProps.part.fileId &&
      prevProps.part.name === nextProps.part.name &&
      prevProps.part.filename === nextProps.part.filename &&
      prevProps.part.mediaType === nextProps.part.mediaType
    );
  },
);
