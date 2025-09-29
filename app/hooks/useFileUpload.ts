import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  MAX_FILES_LIMIT,
  MAX_TOTAL_TOKENS,
  uploadSingleFileToConvex,
  validateFile,
  createFileMessagePartFromUploadedFile,
} from "@/lib/utils/file-utils";
import { FileProcessingResult, FileSource } from "@/types/file";
import { useGlobalState } from "../contexts/GlobalState";
import { Id } from "@/convex/_generated/dataModel";

export const useFileUpload = () => {
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

  const generateUploadUrl = useMutation(api.fileStorage.generateUploadUrl);
  const deleteFile = useMutation(api.fileStorage.deleteFile);
  const saveFile = useAction(api.fileActions.saveFile);

  // Wrap Convex mutation to match `() => Promise<string>` signature expected by the util
  const generateUploadUrlFn = useCallback(
    () => generateUploadUrl({}),
    [generateUploadUrl],
  );

  // Helper function to check and validate files before processing
  const validateAndFilterFiles = useCallback(
    (files: File[]): FileProcessingResult => {
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

      // Validate each file
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];

      for (const file of filesToProcess) {
        const validation = validateFile(file);
        if (validation.valid) {
          validFiles.push(file);
        } else {
          invalidFiles.push(`${file.name}: ${validation.error}`);
        }
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
        uploadFileToConvex(file, startingIndex + index);
      });
    },
    [uploadedFiles.length, addUploadedFile],
  );

  // Unified file processing function
  const processFiles = useCallback(
    async (files: File[], source: FileSource) => {
      // Check if user has pro plan for file uploads
      if (subscription === "free") {
        toast.error("Upgrade plan to upload files.");
        return;
      }

      const result = validateAndFilterFiles(files);

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

  const uploadFileToConvex = async (file: File, uploadIndex: number) => {
    try {
      const { fileId, url, tokens } = await uploadSingleFileToConvex(
        file,
        generateUploadUrlFn,
        saveFile,
      );

      // Check token limit before updating state
      const currentTotal = getTotalTokens();
      const newTotal = currentTotal + tokens;

      if (newTotal > MAX_TOTAL_TOKENS) {
        // Exceeds limit - delete file from storage and remove from upload list
        deleteFile({ fileId: fileId as Id<"files"> }).catch(console.error);
        removeUploadedFile(uploadIndex);

        toast.error(
          `${file.name} exceeds token limit (${newTotal}/${MAX_TOTAL_TOKENS})`,
        );
      } else {
        // Within limits - set success state with tokens
        updateUploadedFile(uploadIndex, {
          tokens,
          uploading: false,
          uploaded: true,
          fileId,
          url,
        });
      }
    } catch (error) {
      console.error("Failed to upload file:", error);
      // Update the upload state to error
      updateUploadedFile(uploadIndex, {
        uploading: false,
        uploaded: false,
        error: error instanceof Error ? error.message : "Upload failed",
      });
      toast.error(
        `Failed to upload ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  };

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
