import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import {
  MAX_FILES_LIMIT,
  validateFile,
  validateImageFile,
  createFileMessagePartFromUploadedFile,
  isImageFile,
  RateLimitInfo,
} from "@/lib/utils/file-utils";
import { MAX_TOKENS_FILE } from "@/lib/token-utils";
import { FileProcessingResult, FileSource } from "@/types/file";
import { useGlobalState } from "../contexts/GlobalState";
import { Id } from "@/convex/_generated/dataModel";

// Show warning when remaining uploads are at or below this threshold
const RATE_LIMIT_WARNING_THRESHOLD = 10;

export const useFileUpload = (mode: "ask" | "agent" = "ask") => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    uploadedFiles,
    addUploadedFile,
    updateUploadedFile,
    removeUploadedFile,
    subscription,
    getTotalTokens,
  } = useGlobalState();

  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const [showDragOverlay, setShowDragOverlay] = useState(false);
  const dragCounterRef = useRef(0);

  // Track last shown rate limit warning to avoid spamming (show once per minute max)
  const lastRateLimitWarningRef = useRef<number>(0);

  const deleteFile = useMutation(api.fileStorage.deleteFile);
  const saveFile = useAction(api.fileActions.saveFile);
  const generateS3UploadUrlAction = useAction(
    api.s3Actions.generateS3UploadUrlAction,
  );

  // Helper to show rate limit warning (throttled to once per minute)
  const showRateLimitWarning = useCallback((rateLimit: RateLimitInfo) => {
    if (rateLimit.remaining > RATE_LIMIT_WARNING_THRESHOLD) {
      return;
    }

    const now = Date.now();
    const timeSinceLastWarning = now - lastRateLimitWarningRef.current;
    const ONE_MINUTE = 60 * 1000;

    if (timeSinceLastWarning < ONE_MINUTE) {
      return;
    }

    lastRateLimitWarningRef.current = now;

    // Calculate time until reset
    const resetMs = rateLimit.reset - now;
    const hours = Math.floor(resetMs / (1000 * 60 * 60));
    const minutes = Math.floor((resetMs % (1000 * 60 * 60)) / (1000 * 60));
    const timeString = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;

    toast.warning(
      `You have ${rateLimit.remaining} file uploads remaining. Resets in ${timeString}.`,
    );
  }, []);

  // Helper function to check and validate files before processing
  const validateAndFilterFiles = useCallback(
    async (files: File[]): Promise<FileProcessingResult> => {
      const existingUploadedCount = uploadedFiles.length;
      const totalFiles = existingUploadedCount + files.length;

      // Check file limits
      let filesToProcess = files;
      let truncated = false;

      if (totalFiles > MAX_FILES_LIMIT) {
        const remainingSlots = MAX_FILES_LIMIT - existingUploadedCount;
        if (remainingSlots <= 0) {
          return {
            validFiles: [],
            invalidFiles: [],
            truncated: false,
            processedCount: 0,
          };
        }
        filesToProcess = files.slice(0, remainingSlots);
        truncated = true;
      }

      // Validate each file (including image validation)
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];

      for (const file of filesToProcess) {
        // Basic validation (size, etc.)
        const basicValidation = validateFile(file);
        if (!basicValidation.valid) {
          invalidFiles.push(`${file.name}: ${basicValidation.error}`);
          continue;
        }

        // Image-specific validation
        if (isImageFile(file)) {
          const imageValidation = await validateImageFile(file);
          if (!imageValidation.valid) {
            invalidFiles.push(`${file.name}: ${imageValidation.error}`);
            continue;
          }
        }

        validFiles.push(file);
      }

      return {
        validFiles,
        invalidFiles,
        truncated,
        processedCount: filesToProcess.length,
      };
    },
    [uploadedFiles.length],
  );

  // Helper function to show feedback messages
  const showProcessingFeedback = useCallback(
    (
      result: FileProcessingResult,
      source: FileSource,
      hasRemainingSlots: boolean = true,
    ) => {
      const messages: string[] = [];

      // Handle case where no slots are available
      if (!hasRemainingSlots) {
        toast.error(
          `Maximum ${MAX_FILES_LIMIT} files allowed. Please remove some files before adding more.`,
        );
        return;
      }

      // Add truncation message
      if (result.truncated) {
        messages.push(
          `Only ${result.processedCount} files were added. Maximum ${MAX_FILES_LIMIT} files allowed.`,
        );
      }

      // Add validation errors
      if (result.invalidFiles.length > 0) {
        messages.push(
          `Some files were invalid:\n${result.invalidFiles.join("\n")}`,
        );
      }

      // Show error messages if any
      if (messages.length > 0) {
        toast.error(messages.join("\n\n"));
      }
    },
    [],
  );

  // Upload file to S3 storage
  const uploadFileToS3 = useCallback(
    async (file: File, uploadIndex: number) => {
      try {
        // Step 1: Generate presigned S3 upload URL
        const { uploadUrl, s3Key, rateLimit } = await generateS3UploadUrlAction(
          {
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
          },
        );

        // Show warning if approaching rate limit
        if (rateLimit) {
          showRateLimitWarning(rateLimit);
        }

        // Step 2: Upload file to S3 using presigned URL
        const uploadResponse = await fetch(uploadUrl, {
          method: "PUT",
          body: file,
          headers: { "Content-Type": file.type || "application/octet-stream" },
        });

        if (!uploadResponse.ok) {
          throw new Error(
            `Failed to upload file ${file.name}: ${uploadResponse.statusText}`,
          );
        }

        // Step 3: Save file metadata to database with S3 key
        const { url, fileId, tokens } = await saveFile({
          s3Key,
          name: file.name,
          mediaType: file.type,
          size: file.size,
          mode,
        });

        // Only check token limit for "ask" mode
        // In "agent" mode, files are accessed in sandbox, no token limit applies
        if (mode === "ask") {
          const currentTotal = getTotalTokens();
          const newTotal = currentTotal + tokens;

          if (newTotal > MAX_TOKENS_FILE) {
            // Exceeds limit - delete file from storage and remove from upload list
            deleteFile({ fileId: fileId as Id<"files"> }).catch(console.error);
            removeUploadedFile(uploadIndex);

            toast.error(
              `${file.name} exceeds token limit (${newTotal.toLocaleString()}/${MAX_TOKENS_FILE.toLocaleString()} tokens). Tip: Switch to Agent mode to upload larger files.`,
            );
            return;
          }
        }

        // Set success state with tokens
        updateUploadedFile(uploadIndex, {
          tokens,
          uploading: false,
          uploaded: true,
          fileId,
          url,
        });
      } catch (error) {
        console.error("Failed to upload file:", error);

        // Extract error message from ConvexError or regular Error
        const errorMessage = (() => {
          if (error instanceof ConvexError) {
            const errorData = error.data as { message?: string };
            return errorData?.message || error.message || "Upload failed";
          }
          if (error instanceof Error) {
            return error.message;
          }
          return "Upload failed";
        })();

        // Update the upload state to error
        updateUploadedFile(uploadIndex, {
          uploading: false,
          uploaded: false,
          error: errorMessage,
        });

        toast.error(errorMessage);
      }
    },
    [
      generateS3UploadUrlAction,
      saveFile,
      getTotalTokens,
      deleteFile,
      removeUploadedFile,
      updateUploadedFile,
      showRateLimitWarning,
      mode,
    ],
  );

  // Helper function to start file uploads
  const startFileUploads = useCallback(
    (files: File[]) => {
      const startingIndex = uploadedFiles.length;

      files.forEach((file, index) => {
        // Add file as "uploading" state immediately
        addUploadedFile({
          file,
          uploading: true,
          uploaded: false,
        });

        // Start upload in background with correct index
        uploadFileToS3(file, startingIndex + index);
      });
    },
    [uploadedFiles.length, addUploadedFile, uploadFileToS3],
  );

  // Unified file processing function
  const processFiles = useCallback(
    async (files: File[], source: FileSource) => {
      // Check if user has pro plan for file uploads
      if (subscription === "free") {
        toast.error("Upgrade plan to upload files.");
        return;
      }

      const result = await validateAndFilterFiles(files);

      // Check if we have slots available
      const existingUploadedCount = uploadedFiles.length;
      const remainingSlots = MAX_FILES_LIMIT - existingUploadedCount;
      const hasRemainingSlots = remainingSlots > 0;

      // Show feedback messages
      showProcessingFeedback(result, source, hasRemainingSlots);

      // Start uploads for valid files
      if (result.validFiles.length > 0 && hasRemainingSlots) {
        startFileUploads(result.validFiles);
      }
    },
    [
      subscription,
      validateAndFilterFiles,
      showProcessingFeedback,
      startFileUploads,
      uploadedFiles.length,
    ],
  );

  const handleFileUploadEvent = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    await processFiles(Array.from(selectedFiles), "upload");

    // Clear the input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRemoveFile = async (indexToRemove: number) => {
    const uploadedFile = uploadedFiles[indexToRemove];

    // If the file was uploaded to Convex, delete it from storage
    if (uploadedFile?.fileId) {
      try {
        await deleteFile({
          fileId: uploadedFile.fileId as Id<"files">,
        });
      } catch (error) {
        console.error("Failed to delete file from storage:", error);
        toast.error("Failed to delete file from storage");
      }
    }

    // removeUploadedFile in GlobalState will automatically handle token removal
    removeUploadedFile(indexToRemove);
  };

  const handleAttachClick = () => {
    fileInputRef.current?.click();
  };

  const handlePasteEvent = async (event: ClipboardEvent): Promise<boolean> => {
    const items = event.clipboardData?.items;
    if (!items) return false;

    const files: File[] = [];

    // Extract files from clipboard
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length === 0) return false;

    // Prevent default paste behavior to avoid pasting file names as text
    event.preventDefault();

    await processFiles(files, "paste");
    return true;
  };

  // Helper to get all uploaded file message parts for sending
  const getUploadedFileMessageParts = () => {
    return uploadedFiles
      .map(createFileMessagePartFromUploadedFile)
      .filter((part): part is NonNullable<typeof part> => part !== null);
  };

  // Helper to check if all files have finished uploading
  const allFilesUploaded = () => {
    return (
      uploadedFiles.length > 0 &&
      uploadedFiles.every((file) => file.uploaded && !file.uploading)
    );
  };

  // Helper to check if any files are currently uploading
  const anyFilesUploading = () => {
    return uploadedFiles.some((file) => file.uploading);
  };

  // Drag and drop event handlers
  const handleDragEnter = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current++;

    if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
      setShowDragOverlay(true);
    }
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current--;

    if (dragCounterRef.current === 0) {
      setShowDragOverlay(false);
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }

    setIsDragOver(true);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();

      // Reset drag state
      setShowDragOverlay(false);
      setIsDragOver(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      await processFiles(Array.from(files), "drop");
    },
    [processFiles],
  );

  return {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleAttachClick,
    handlePasteEvent,
    getUploadedFileMessageParts,
    allFilesUploaded,
    anyFilesUploading,
    getTotalTokens,
    // Drag and drop state and handlers
    isDragOver,
    showDragOverlay,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
};
