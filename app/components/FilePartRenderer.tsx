import Image from "next/image";
import React, { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Id } from "@/convex/_generated/dataModel";
import { ImageViewer } from "./ImageViewer";
import { Loader2, FileText, AlertCircle, File } from "lucide-react";

interface FilePartRendererProps {
  part: any;
  partIndex: number;
  messageId: string;
  totalFileParts?: number;
}

export const FilePartRenderer = ({
  part,
  partIndex,
  messageId,
  totalFileParts = 1,
}: FilePartRendererProps) => {
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  // Reusable file preview UI component
  const FilePreviewCard = ({
    partId,
    icon,
    fileName,
    subtitle,
  }: {
    partId: string;
    icon: React.ReactNode;
    fileName: string;
    subtitle: string;
  }) => (
    <div key={partId} className="p-2 w-full max-w-80 min-w-64 border rounded-lg bg-background">
      <div className="flex flex-row items-center gap-2">
        <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-[#FF5588] flex items-center justify-center">
          {icon}
        </div>
        <div className="overflow-hidden">
          <div className="truncate font-semibold text-sm">
            {fileName}
          </div>
          <div className="text-muted-foreground truncate text-xs">
            {subtitle}
          </div>
        </div>
      </div>
    </div>
  );

  const ConvexFilePart = ({ part, partId }: { part: any; partId: string }) => {
    // Use direct URL if available, otherwise fetch from storageId (for legacy messages)
    const shouldFetchUrl = part.storageId && !part.url;
    const fileUrl = useQuery(
      api.messages.getFileUrl,
      shouldFetchUrl ? { storageId: part.storageId as Id<"_storage"> } : "skip"
    );

    // Determine the actual URL to use
    const actualUrl = part.url || fileUrl;

    if (shouldFetchUrl && fileUrl === undefined) {
      // Loading state for legacy storageId-based files
      return (
        <FilePreviewCard
          partId={partId}
          icon={<Loader2 className="h-6 w-6 text-white animate-spin" />}
          fileName={part.name || part.filename || "Unknown file"}
          subtitle="Loading file..."
        />
      );
    }

    if (!actualUrl || (shouldFetchUrl && fileUrl === null)) {
      // File not found or error
      return (
        <FilePreviewCard
          partId={partId}
          icon={<AlertCircle className="h-6 w-6 text-white" />}
          fileName={part.name || part.filename || "Unknown file"}
          subtitle="File not found"
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
              onClick={() => setSelectedImage({ src: actualUrl, alt: altText })}
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
      />
    );
  };

  const renderFilePart = () => {
    const partId = `${messageId}-file-${partIndex}`;

    // Check if this is a file part with either URL or storageId
    if (part.url || part.storageId) {
      return <ConvexFilePart part={part} partId={partId} />;
    }

    // Fallback for unsupported file types
    return (
      <FilePreviewCard
        partId={partId}
        icon={<File className="h-6 w-6 text-white" />}
        fileName={part.name || part.filename || "Unknown file"}
        subtitle="Document"
      />
    );
  };

  return (
    <>
      {renderFilePart()}
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
