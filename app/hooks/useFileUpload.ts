import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  MAX_FILES_LIMIT,
  uploadSingleFileToConvex,
  validateFile,
  type UploadedFileState,
  createFileMessagePartFromUploadedFile,
} from "@/lib/utils/file-utils";
import { useGlobalState } from "../contexts/GlobalState";

type FileProcessingResult = {
  validFiles: File[];
  invalidFiles: string[];
  truncated: boolean;
  processedCount: number;
};

type FileSource = "upload" | "paste" | "drop";

export const useFileUpload = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const {
    uploadedFiles,
    addUploadedFile,
    updateUploadedFile,
    removeUploadedFile,
  } = useGlobalState();

  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const [showDragOverlay, setShowDragOverlay] = useState(false);
  const dragCounterRef = useRef(0);

  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);
  const deleteFile = useMutation(api.messages.deleteFile);
  const getFileUrl = useMutation(api.messages.getFileUrls);

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
      files.forEach((file, index) => {
        // Add file as "uploading" state immediately
        const uploadState: UploadedFileState = {
          file,
          uploading: true,
          uploaded: false,
        };
        addUploadedFile(uploadState);

        // Start upload in background
        const uploadIndex = uploadedFiles.length + index;
        uploadFileToConvex(file, uploadIndex);
      });
    },
    [uploadedFiles.length, addUploadedFile],
  );

  // Unified file processing function
  const processFiles = useCallback(
    async (files: File[], source: FileSource) => {
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
      validateAndFilterFiles,
      showProcessingFeedback,
      startFileUploads,
      uploadedFiles.length,
    ],
  );

  const uploadFileToConvex = async (file: File, uploadIndex: number) => {
    try {
      const storageId = await uploadSingleFileToConvex(file, generateUploadUrl);

      // Fetch the URL immediately after upload
      const urls = await getFileUrl({ storageIds: [storageId as any] });
      const url = urls[0];

      // Update the upload state to completed with storage ID and URL
      updateUploadedFile(uploadIndex, {
        uploading: false,
        uploaded: true,
        storageId,
        url: url || undefined,
      });
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
    if (uploadedFile?.storageId) {
      try {
        await deleteFile({ storageId: uploadedFile.storageId as any });
      } catch (error) {
        console.error("Failed to delete file from storage:", error);
        toast.error("Failed to delete file from storage");
      }
    }

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
    // Drag and drop state and handlers
    isDragOver,
    showDragOverlay,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
  };
};
