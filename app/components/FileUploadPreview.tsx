import { Button } from "@/components/ui/button";
import { X, File as FileIcon, FileText, Loader2 } from "lucide-react";
import { useEffect, useState, useCallback, useRef } from "react";
import Image from "next/image";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
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
  LocalDesktopFile,
} from "@/types/file";

const isBrowserFile = (file: File | LocalDesktopFile): file is File =>
  typeof globalThis.File !== "undefined" && file instanceof globalThis.File;

const GENERATED_TEXT_SAVE_DEBOUNCE_MS = 600;
export const FileUploadPreview = ({
  uploadedFiles,
  onRemoveFile,
  onUpdateGeneratedTextFile,
}: FileUploadPreviewProps) => {
  const [filePreviews, setFilePreviews] = useState<FilePreview[]>([]);
  const [selectedImage, setSelectedImage] = useState<{
    src: string;
    alt: string;
  } | null>(null);
  const [editingTextFileIndex, setEditingTextFileIndex] = useState<
    number | null
  >(null);
  const [draftTextContent, setDraftTextContent] = useState("");
  const [hasPendingTextSave, setHasPendingTextSave] = useState(false);
  const textSaveTimeoutRef = useRef<number | null>(null);
  const draftTextContentRef = useRef("");

  // Use ref to store base64 previews to avoid regenerating them
  const previewCache = useRef<Map<string, string>>(new Map());

  const generateFileKey = useCallback((file: File): string => {
    return `${file.name}_${file.size}_${file.lastModified}`;
  }, []);

  const activeTextFile =
    editingTextFileIndex === null
      ? null
      : uploadedFiles[editingTextFileIndex] || null;
  const activeGeneratedText = activeTextFile?.generatedTextAttachment;

  const saveGeneratedTextFile = useCallback(
    (index: number, content: string) => {
      if (!onUpdateGeneratedTextFile) return;
      onUpdateGeneratedTextFile(index, content);
      setHasPendingTextSave(false);
    },
    [onUpdateGeneratedTextFile],
  );

  const clearTextSaveTimeout = useCallback(() => {
    if (textSaveTimeoutRef.current !== null) {
      window.clearTimeout(textSaveTimeoutRef.current);
      textSaveTimeoutRef.current = null;
    }
  }, []);

  const flushPendingTextSave = useCallback(() => {
    if (editingTextFileIndex === null || !hasPendingTextSave) return;
    clearTextSaveTimeout();
    saveGeneratedTextFile(editingTextFileIndex, draftTextContentRef.current);
  }, [
    clearTextSaveTimeout,
    editingTextFileIndex,
    hasPendingTextSave,
    saveGeneratedTextFile,
  ]);

  const openTextEditor = useCallback(
    (index: number) => {
      const generatedText = uploadedFiles[index]?.generatedTextAttachment;
      if (!generatedText || !onUpdateGeneratedTextFile) return;

      clearTextSaveTimeout();
      setEditingTextFileIndex(index);
      setDraftTextContent(generatedText.content);
      draftTextContentRef.current = generatedText.content;
      setHasPendingTextSave(false);
    },
    [clearTextSaveTimeout, onUpdateGeneratedTextFile, uploadedFiles],
  );

  const handleTextEditorOpenChange = useCallback(
    (open: boolean) => {
      if (open) return;
      flushPendingTextSave();
      setEditingTextFileIndex(null);
      setHasPendingTextSave(false);
    },
    [flushPendingTextSave],
  );

  const handleDraftTextChange = useCallback(
    (value: string) => {
      if (editingTextFileIndex === null) return;

      setDraftTextContent(value);
      draftTextContentRef.current = value;
      setHasPendingTextSave(true);
      clearTextSaveTimeout();

      textSaveTimeoutRef.current = window.setTimeout(() => {
        textSaveTimeoutRef.current = null;
        saveGeneratedTextFile(editingTextFileIndex, value);
      }, GENERATED_TEXT_SAVE_DEBOUNCE_MS);
    },
    [clearTextSaveTimeout, editingTextFileIndex, saveGeneratedTextFile],
  );

  const handleRemoveUploadedFile = useCallback(
    (index: number) => {
      if (index === editingTextFileIndex) {
        clearTextSaveTimeout();
        setEditingTextFileIndex(null);
        setHasPendingTextSave(false);
      }
      onRemoveFile(index);
    },
    [clearTextSaveTimeout, editingTextFileIndex, onRemoveFile],
  );

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
        if (
          isImageFile(uploadedFile.file) &&
          isBrowserFile(uploadedFile.file)
        ) {
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

  useEffect(() => {
    return () => {
      clearTextSaveTimeout();
    };
  }, [clearTextSaveTimeout]);

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
            {filePreviews.map((filePreview, index) => {
              const uploadedFile = uploadedFiles[index];
              const generatedText = uploadedFile?.generatedTextAttachment;
              const isGeneratedPastedText = Boolean(
                generatedText ||
                uploadedFile?.generatedSource === "pasted-text",
              );
              const canEditGeneratedText = Boolean(
                generatedText && onUpdateGeneratedTextFile,
              );

              return (
                <div
                  key={`${filePreview.file.name}-${index}`}
                  className="group text-token-text-primary relative inline-block text-sm"
                  data-testid="attached-file"
                >
                  <div
                    className={`relative overflow-hidden border rounded-2xl ${
                      filePreview.error
                        ? "border-red-500 border-2 bg-red-50 dark:bg-red-950/20"
                        : isGeneratedPastedText
                          ? "bg-input-chat border-border/80"
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
                      ) : isGeneratedPastedText ? (
                        <button
                          type="button"
                          className="block w-72 p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-2xl"
                          onClick={() => openTextEditor(index)}
                          disabled={!canEditGeneratedText}
                          aria-label={`Open ${filePreview.file.name}`}
                        >
                          <div className="flex flex-row items-start gap-2">
                            <div
                              className={`relative h-10 w-10 shrink-0 overflow-hidden rounded-lg flex items-center justify-center ${
                                filePreview.error
                                  ? "bg-red-500"
                                  : "bg-black/70 dark:bg-black/80"
                              }`}
                            >
                              {filePreview.uploading ? (
                                <Loader2 className="h-6 w-6 text-white animate-spin" />
                              ) : (
                                <FileText className="h-6 w-6 text-white" />
                              )}
                            </div>
                            <div className="overflow-hidden flex-1 min-w-0">
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
                                {filePreview.error ? (
                                  "Upload failed"
                                ) : !canEditGeneratedText ? (
                                  <>
                                    Text ·{" "}
                                    {formatFileSize(filePreview.file.size)}
                                  </>
                                ) : (
                                  <>
                                    <span className="group-hover:hidden group-focus-within:hidden">
                                      Text ·{" "}
                                      {formatFileSize(filePreview.file.size)}
                                    </span>
                                    <span className="hidden group-hover:inline group-focus-within:inline">
                                      Click to edit
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        </button>
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
                                filePreview.error
                                  ? "bg-red-500"
                                  : "bg-[#FF5588]"
                              }`}
                            >
                              {filePreview.uploading ? (
                                <Loader2 className="h-6 w-6 text-white animate-spin" />
                              ) : filePreview.error ? (
                                <X className="h-6 w-6 text-white" />
                              ) : (
                                <FileIcon className="h-6 w-6 text-white" />
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
                                  : `${uploadedFile?.storage === "local-desktop" ? "Local file" : "Document"} • ${formatFileSize(filePreview.file.size)}`}
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
                      onClick={() => handleRemoveUploadedFile(index)}
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
              );
            })}
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

      <Dialog
        open={editingTextFileIndex !== null && !!activeGeneratedText}
        onOpenChange={handleTextEditorOpenChange}
      >
        <DialogContent
          showCloseButton={false}
          className="flex h-[calc(100vh-32px)] w-[calc(100vw-32px)] max-w-[1200px] flex-col gap-0 overflow-hidden rounded-2xl border-border/80 bg-input-chat p-0 shadow-2xl md:h-[calc(100vh-80px)] md:w-[calc(100vw-80px)]"
        >
          <DialogHeader className="flex h-14 shrink-0 flex-row items-center justify-between gap-4 border-b border-border/80 px-4 py-3 text-left">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-blue-700 text-white dark:bg-blue-600">
                <FileText className="size-5" />
              </div>
              <div className="min-w-0">
                <DialogTitle className="truncate text-sm font-medium leading-5">
                  {activeTextFile?.file.name}
                </DialogTitle>
                <DialogDescription className="truncate text-xs">
                  {hasPendingTextSave || activeTextFile?.uploading
                    ? "Saving changes..."
                    : activeTextFile?.error
                      ? "Upload failed. Edit the text to retry."
                      : "Changes save automatically as you edit"}
                </DialogDescription>
              </div>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 shrink-0 rounded-lg text-muted-foreground hover:bg-white/10 hover:text-foreground"
                aria-label="Close pasted text editor"
              >
                <X className="size-4" />
              </Button>
            </DialogClose>
          </DialogHeader>

          <div className="flex min-h-0 flex-1">
            <Textarea
              value={draftTextContent}
              onChange={(event) => handleDraftTextChange(event.target.value)}
              className="h-full min-h-0 flex-1 resize-none rounded-none border-0 bg-transparent p-5 font-mono text-sm leading-6 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
              aria-label="Pasted text content"
              spellCheck={false}
            />
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
