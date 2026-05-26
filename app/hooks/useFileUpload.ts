import { useRef, useState, useCallback } from "react";
import { toast } from "sonner";
import { useMutation, useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@/convex/_generated/api";
import {
  getMaxFilesLimitForMode,
  MAX_IMAGE_SIZE,
  validateFile,
  validateImageFile,
  createFileMessagePartFromUploadedFile,
  isImageFile,
  RateLimitInfo,
} from "@/lib/utils/file-utils";
import { getMaxFileTokens } from "@/lib/token-utils";
import {
  FileProcessingResult,
  FileSource,
  LocalDesktopFile,
} from "@/types/file";
import type { ChatMode } from "@/types/chat";
import { useGlobalState } from "../contexts/GlobalState";
import { Id } from "@/convex/_generated/dataModel";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import {
  getLocalFileMetadata,
  isTauriEnvironment,
  pickLocalFiles,
  readLocalFile,
} from "./useTauri";

// Show warning when remaining uploads are at or below this threshold
const RATE_LIMIT_WARNING_THRESHOLD = 10;

const logLocalAttachmentDebug = (
  event: string,
  data: Record<string, unknown>,
) => {
  if (typeof window === "undefined") return;
  const enabled =
    process.env.NODE_ENV === "development" ||
    window.localStorage.getItem("hackerai:debug-local-attachments") === "1";
  if (!enabled) return;
  console.info(`[local-attachments] ${event}`, data);
};

const getFilenameFromPath = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).pop() || "selected file";

const getConvexErrorCode = (error: unknown): string | undefined => {
  if (error instanceof ConvexError) {
    const errorData = error.data as { code?: string };
    return errorData?.code;
  }
  return undefined;
};

const isExpectedFileUploadError = (error: unknown): boolean => {
  const code = getConvexErrorCode(error);
  return (
    code === "FILE_TOKEN_LIMIT_EXCEEDED" ||
    code === "FILE_UPLOAD_RATE_LIMIT" ||
    code === "PAID_PLAN_REQUIRED"
  );
};

const fileFromBase64 = (
  base64: string,
  name: string,
  type: string,
  lastModified: number,
): File => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new File([bytes], name, {
    type: type || "application/octet-stream",
    lastModified,
  });
};

export const useFileUpload = (mode: ChatMode = "ask") => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const maxFilesLimit = getMaxFilesLimitForMode(mode);
  const {
    uploadedFiles,
    addUploadedFile,
    updateUploadedFile,
    removeUploadedFile,
    subscription,
    getTotalTokens,
    sandboxPreference,
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

  const shouldUseLocalDesktopAttachments =
    isTauriEnvironment() &&
    isAgentMode(mode) &&
    sandboxPreference === "desktop";

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

      if (totalFiles > maxFilesLimit) {
        const remainingSlots = maxFilesLimit - existingUploadedCount;
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
        const basicValidation = validateFile(file, { mode });
        if (!basicValidation.valid) {
          invalidFiles.push(`${file.name}: ${basicValidation.error}`);
          continue;
        }

        // Provider-visible images should be decodable; larger Agent images are
        // staged into the sandbox instead of sent inline to the model.
        if (
          isImageFile(file) &&
          (mode !== "agent" || file.size <= MAX_IMAGE_SIZE)
        ) {
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
    [uploadedFiles.length, maxFilesLimit, mode],
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
          `Maximum ${maxFilesLimit} files allowed. Please remove some files before adding more.`,
        );
        return;
      }

      // Add truncation message
      if (result.truncated) {
        messages.push(
          `Only ${result.processedCount} files were added. Maximum ${maxFilesLimit} files allowed.`,
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
    [maxFilesLimit],
  );

  // Upload file to S3 storage
  const uploadFileToS3 = useCallback(
    async (
      file: File,
      uploadIndex: number,
      options: {
        fallbackLocalFile?: LocalDesktopFile & { path: string };
      } = {},
    ) => {
      try {
        logLocalAttachmentDebug("s3-upload-start", {
          fileName: file.name,
          mode,
          sandboxPreference,
        });

        // Step 1: Generate presigned S3 upload URL
        const { uploadUrl, s3Key, rateLimit } = await generateS3UploadUrlAction(
          {
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            size: file.size,
            mode,
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

          const maxFileTokens = getMaxFileTokens(subscription);
          if (newTotal > maxFileTokens) {
            // Exceeds limit - delete file from storage and remove from upload list
            deleteFile({ fileId: fileId as Id<"files"> }).catch(console.error);
            removeUploadedFile(uploadIndex);

            toast.error(
              `${file.name} exceeds token limit (${newTotal.toLocaleString()}/${maxFileTokens.toLocaleString()} tokens). Tip: Switch to Agent mode to upload larger files.`,
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
        if (
          getConvexErrorCode(error) === "FILE_UPLOAD_RATE_LIMIT" &&
          options.fallbackLocalFile
        ) {
          const fallbackFile = options.fallbackLocalFile;
          updateUploadedFile(uploadIndex, {
            file: {
              name: fallbackFile.name,
              type: fallbackFile.type,
              size: fallbackFile.size,
              lastModified: fallbackFile.lastModified,
            },
            uploading: false,
            uploaded: true,
            storage: "local-desktop",
            localAttachmentId:
              typeof crypto !== "undefined" && crypto.randomUUID
                ? crypto.randomUUID()
                : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            localPath: fallbackFile.path,
            tokens: 0,
            error: undefined,
          });
          toast.warning(
            `${fallbackFile.name} was added for desktop Agent access. Cloud preview is temporarily limited.`,
          );
          return;
        }

        if (!isExpectedFileUploadError(error)) {
          console.error("Failed to upload file:", error);
        }

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
      sandboxPreference,
      subscription,
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

  const startDesktopSelectedFiles = useCallback(
    (
      files: Array<
        | {
            storage: "local-desktop";
            file: LocalDesktopFile & { path: string };
          }
        | {
            storage: "s3";
            file: File;
            fallbackLocalFile?: LocalDesktopFile & { path: string };
          }
      >,
    ) => {
      const startingIndex = uploadedFiles.length;

      files.forEach((entry, index) => {
        if (entry.storage === "s3") {
          addUploadedFile({
            file: entry.file,
            uploading: true,
            uploaded: false,
            storage: "s3",
          });
          uploadFileToS3(entry.file, startingIndex + index, {
            fallbackLocalFile: entry.fallbackLocalFile,
          });
          return;
        }

        addUploadedFile({
          file: {
            name: entry.file.name,
            type: entry.file.type,
            size: entry.file.size,
            lastModified: entry.file.lastModified,
          },
          uploading: false,
          uploaded: true,
          storage: "local-desktop",
          localAttachmentId:
            typeof crypto !== "undefined" && crypto.randomUUID
              ? crypto.randomUUID()
              : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          localPath: entry.file.path,
          tokens: 0,
        });
        logLocalAttachmentDebug("local-file-added", {
          fileName: entry.file.name,
          mediaType: entry.file.type,
          size: entry.file.size,
          hasLocalPath: Boolean(entry.file.path),
        });
      });
    },
    [addUploadedFile, uploadFileToS3, uploadedFiles.length],
  );

  const processLocalDesktopPaths = useCallback(
    async (paths: string[]) => {
      if (subscription === "free") {
        toast.error("Upgrade plan to upload files.");
        return;
      }

      const existingUploadedCount = uploadedFiles.length;
      const remainingSlots = maxFilesLimit - existingUploadedCount;
      if (remainingSlots <= 0) {
        toast.error(
          `Maximum ${maxFilesLimit} files allowed. Please remove some files before adding more.`,
        );
        return;
      }

      const selectedPaths = paths.slice(0, remainingSlots);
      if (paths.length > selectedPaths.length) {
        toast.error(
          `Only ${selectedPaths.length} files were added. Maximum ${maxFilesLimit} files allowed.`,
        );
      }

      const validFiles: Array<
        | {
            storage: "local-desktop";
            file: LocalDesktopFile & { path: string };
          }
        | {
            storage: "s3";
            file: File;
            fallbackLocalFile?: LocalDesktopFile & { path: string };
          }
      > = [];
      const invalidFiles: string[] = [];

      for (const path of selectedPaths) {
        let metadata: Awaited<ReturnType<typeof getLocalFileMetadata>>;
        try {
          metadata = await getLocalFileMetadata(path);
        } catch (error) {
          logLocalAttachmentDebug("local-metadata-error", {
            fileName: getFilenameFromPath(path),
            error: error instanceof Error ? error.message : String(error),
          });
          invalidFiles.push(
            `${getFilenameFromPath(path)}: could not read file metadata`,
          );
          continue;
        }
        if (!metadata) {
          invalidFiles.push(
            `${getFilenameFromPath(path)}: could not read file metadata`,
          );
          continue;
        }

        const file = {
          path: metadata.path,
          name: metadata.name,
          type: metadata.mediaType || "application/octet-stream",
          size: metadata.size,
          lastModified: metadata.lastModified || Date.now(),
        };
        logLocalAttachmentDebug("local-metadata-read", {
          fileName: file.name,
          mediaType: file.type,
          size: file.size,
          hasLocalPath: Boolean(file.path),
        });
        const validation = validateFile(file, { mode });
        if (!validation.valid) {
          invalidFiles.push(`${file.name}: ${validation.error}`);
          continue;
        }

        if (isImageFile(file)) {
          if (isAgentMode(mode) && file.size > MAX_IMAGE_SIZE) {
            validFiles.push({ storage: "local-desktop", file });
            continue;
          }

          const localFileData = await readLocalFile(path);
          if (!localFileData) {
            invalidFiles.push(`${file.name}: could not read image file`);
            continue;
          }
          const browserFile = fileFromBase64(
            localFileData.base64,
            localFileData.name,
            localFileData.mediaType || "application/octet-stream",
            localFileData.lastModified || Date.now(),
          );
          const imageValidation = await validateImageFile(browserFile);
          if (!imageValidation.valid) {
            invalidFiles.push(`${browserFile.name}: ${imageValidation.error}`);
            continue;
          }
          validFiles.push({
            storage: "s3",
            file: browserFile,
            fallbackLocalFile: file,
          });
          continue;
        }

        validFiles.push({ storage: "local-desktop", file });
      }

      if (invalidFiles.length > 0) {
        toast.error(`Some files were invalid:\n${invalidFiles.join("\n")}`);
      }
      if (validFiles.length > 0) {
        startDesktopSelectedFiles(validFiles);
      }
    },
    [
      subscription,
      uploadedFiles.length,
      maxFilesLimit,
      startDesktopSelectedFiles,
      mode,
    ],
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
      const remainingSlots = maxFilesLimit - existingUploadedCount;
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
      maxFilesLimit,
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
    if (uploadedFile?.fileId && uploadedFile.storage !== "local-desktop") {
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
    const isTauri = isTauriEnvironment();
    logLocalAttachmentDebug("attach-click", {
      isTauri,
      mode,
      sandboxPreference,
      shouldUseLocalDesktopAttachments,
    });

    if (shouldUseLocalDesktopAttachments) {
      pickLocalFiles()
        .then(async (paths) => {
          logLocalAttachmentDebug("local-picker-result", {
            selectedCount: paths.length,
          });
          if (paths.length > 0) {
            await processLocalDesktopPaths(paths);
          }
        })
        .catch((error) => {
          logLocalAttachmentDebug("local-picker-error", {
            error: error instanceof Error ? error.message : String(error),
          });
          toast.error("Failed to open file picker");
        });
      return;
    }
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
