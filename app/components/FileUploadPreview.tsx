import { Button } from "@/components/ui/button";
import { X, File, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import {
  fileToBase64,
  formatFileSize,
  isImageFile,
} from "@/lib/utils/file-utils";
import { ImageViewer } from "./ImageViewer";
import {
  UploadedFileState,
  FileUploadPreviewProps,
  FilePreview,
} from "@/types/file";

export const FileUploadPreview = ({
  uploadedFiles,
  onRemoveFile,
}: FileUploadPreviewProps) => {
  const [filePreviews, setFilePreviews] = useState<FilePreview[]>([]);
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);

  // Use ref to store base64 previews to avoid regenerating them
  const previewCache = useRef<Map<string, string>>(new Map());

  const generateFileKey = useCallback((file: File): string => {
    return `${file.name}_${file.size}_${file.lastModified}`;
  }, []);

  useEffect(() => {
    const loadPreviews = async () => {
      const previews: FilePreview[] = [];

      for (const uploadedFile of uploadedFiles) {
        const preview: FilePreview = {
          file: uploadedFile.file,
          loading: false,
          uploading: uploadedFile.uploading,
          uploaded: uploadedFile.uploaded,
          error: uploadedFile.error,
        };

        // Generate base64 preview for images - this will show immediately while uploading
        if (isImageFile(uploadedFile.file)) {
          const fileKey = generateFileKey(uploadedFile.file);
          const cachedPreview = previewCache.current.get(fileKey);

          if (cachedPreview) {
            // Use cached preview
            preview.preview = cachedPreview;
          } else {
            // Generate new base64 preview
            preview.loading = true;
            try {
              const base64Preview = await fileToBase64(uploadedFile.file);
              preview.preview = base64Preview;
              // Cache the preview
              previewCache.current.set(fileKey, base64Preview);
            } catch (error) {
              console.error("Error converting file to base64:", error);
            }
            preview.loading = false;
          }
        }

        previews.push(preview);
      }

      setFilePreviews(previews);
    };

    if (uploadedFiles && uploadedFiles.length > 0) {
      loadPreviews();
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setFilePreviews([]);
      // Don't clear cache when no files - we might get the same files back
    }
  }, [uploadedFiles, generateFileKey]);

  if (!uploadedFiles || uploadedFiles.length === 0) {
    return null;
  }

  const hasMultipleFiles = uploadedFiles.length > 1;

  const handleImageClick = (preview: string, fileName: string) => {
    setSelectedImage({ src: preview, alt: fileName });
  };

  return (
    <>
      <div className="flex flex-col gap-3 rounded-t-[22px] transition-all relative bg-input-chat py-3 shadow-[0px_12px_32px_0px_rgba(0,0,0,0.02)] border border-black/8 dark:border-border border-b-0">
        <div className="w-full">
          <div className="no-scrollbar horizontal-scroll-fade-mask flex flex-nowrap gap-2 overflow-x-auto px-2.5 [--edge-fade-distance:1rem]">
            {filePreviews.map((filePreview, index) => (
              <div
                key={`${filePreview.file.name}-${index}`}
                className="group text-token-text-primary relative inline-block text-sm"
                data-testid="attached-file"
              >
                <div
                  className={`relative overflow-hidden border rounded-2xl ${
                    filePreview.error
                      ? "border-red-500 border-2 bg-red-50 dark:bg-red-950/20"
                      : isImageFile(filePreview.file)
                        ? "bg-background"
                        : "bg-primary"
                  }`}
                >
                  <div
                    className={
                      isImageFile(filePreview.file)
                        ? hasMultipleFiles
                          ? "h-14.5 w-14.5"
                          : "h-36 w-36"
                        : ""
                    }
                  >
                    {filePreview.loading && !filePreview.preview ? (
                      <div className="h-full w-full flex items-center justify-center bg-muted">
                        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-foreground"></div>
                      </div>
                    ) : filePreview.error ? (
                      isImageFile(filePreview.file) ? (
                        <div className="h-full w-full flex items-center justify-center min-h-[100px]">
                          <div className="flex flex-col items-center gap-2 p-3">
                            <div className="rounded-full bg-red-500 p-2">
                              <X className="h-5 w-5 text-white" />
                            </div>
                            <span className="text-xs font-semibold text-red-600 dark:text-red-400 text-center">
                              Upload failed
                            </span>
                          </div>
                        </div>
                      ) : (
                        <div className="p-2 w-80">
                          <div className="flex flex-row items-center gap-2">
                            <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg flex items-center justify-center bg-red-500">
                              <X className="h-6 w-6 text-white" />
                            </div>
                            <div className="overflow-hidden flex-1">
                              <div className="truncate font-semibold text-sm">
                                {filePreview.file.name}
                              </div>
                              <div className="text-red-600 dark:text-red-400 font-medium text-xs">
                                Upload failed
                              </div>
                            </div>
                          </div>
                        </div>
                      )
                    ) : filePreview.preview ? (
                      <button
                        className="h-full w-full overflow-hidden relative"
                        onClick={() =>
                          handleImageClick(
                            filePreview.preview!,
                            filePreview.file.name,
                          )
                        }
                      >
                        <Image
                          src={filePreview.preview}
                          alt={filePreview.file.name}
                          className="h-full w-full object-cover"
                          fill
                          unoptimized
                        />
                        {/* Upload overlay - show spinner overlay on top of image while uploading */}
                        {filePreview.uploading && (
                          <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                            <Loader2 className="h-4 w-4 animate-spin text-white" />
                          </div>
                        )}
                      </button>
                    ) : (
                      <div className="p-2 w-80">
                        <div className="flex flex-row items-center gap-2">
                          <div
                            className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-lg flex items-center justify-center ${
                              filePreview.error ? "bg-red-500" : "bg-[#FF5588]"
                            }`}
                          >
                            {filePreview.uploading ? (
                              <Loader2 className="h-6 w-6 text-white animate-spin" />
                            ) : filePreview.error ? (
                              <X className="h-6 w-6 text-white" />
                            ) : (
                              <File className="h-6 w-6 text-white" />
                            )}
                          </div>
                          <div className="overflow-hidden flex-1">
                            <div className="truncate font-semibold text-sm">
                              {filePreview.file.name}
                            </div>
                            <div
                              className={`truncate text-xs ${
                                filePreview.error
                                  ? "text-red-600 dark:text-red-400 font-medium"
                                  : "text-muted-foreground"
                              }`}
                            >
                              {filePreview.error
                                ? "Upload failed"
                                : `Document • ${formatFileSize(filePreview.file.size)}`}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="absolute end-1.5 top-1.5 inline-flex gap-1">
                  <Button
                    type="button"
                    onClick={() => onRemoveFile(index)}
                    variant="secondary"
                    size="sm"
                    className="transition-colors flex h-6 w-6 items-center justify-center rounded-full border-[rgba(0,0,0,0.1)] bg-black text-white dark:border-[rgba(255,255,255,0.1)] dark:bg-white dark:text-black p-0"
                    aria-label="Remove file"
                    data-testid="remove-file"
                  >
                    <X className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Image Viewer Modal */}
      {selectedImage && selectedImage.src && (
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
