import { useDeletionConfirmation } from "@/app/hooks/useDeletionConfirmation";
import { useEffect, useRef, useState, useCallback } from "react";
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
import { getMaxFileTokens } from "@/lib/token-limits";
import {
  FileProcessingResult,
  LocalDesktopFile,
  UploadedFileState,
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
  removeGeneratedTextAttachment,
  writeGeneratedTextAttachment,
} from "./useTauri";
import { PASTED_TEXT_ATTACHMENT_MIN_CHARS } from "@/lib/utils/pasted-text-attachments";
import { getPreferredFileStorageRegion } from "@/lib/storage/file-storage-region";

import {
  browserUploadTransfers,
  putBrowserFile,
  UploadTransportError,
} from "@/lib/utils/browser-file-upload";

// Show warning when remaining uploads are at or below this threshold
const RATE_LIMIT_WARNING_THRESHOLD = 10;
const PASTED_TEXT_ATTACHMENT_BASE_NAME = "Pasted text";
const PASTED_TEXT_ATTACHMENT_EXTENSION = ".txt";
const TEXT_PLAIN_MEDIA_TYPE = "text/plain";

const createGeneratedTextFile = (content: string, name: string): File =>
  new File([content], name, {
    type: TEXT_PLAIN_MEDIA_TYPE,
    lastModified: Date.now(),
  });

const createGeneratedTextLocalFile = (
  metadata: {
    name: string;
    mediaType: string;
    size: number;
    lastModified: number;
  },
  fallbackName: string,
): LocalDesktopFile => ({
  name: metadata.name || fallbackName,
  type: metadata.mediaType || TEXT_PLAIN_MEDIA_TYPE,
  size: metadata.size,
  lastModified: metadata.lastModified || Date.now(),
});

const getClipboardPlainText = (event: ClipboardEvent): string => {
  const clipboardData = event.clipboardData;
  if (!clipboardData) return "";
  return (
    clipboardData.getData("text/plain") || clipboardData.getData("text") || ""
  );
};

const createGeneratedTextAttachmentId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

const getGeneratedPasteFileName = (
  existingFiles: UploadedFileState[],
): string => {
  const existingNames = new Set(existingFiles.map((file) => file.file.name));
  const firstName = `${PASTED_TEXT_ATTACHMENT_BASE_NAME}${PASTED_TEXT_ATTACHMENT_EXTENSION}`;
  if (!existingNames.has(firstName)) return firstName;

  let suffix = 2;
  while (
    existingNames.has(
      `${PASTED_TEXT_ATTACHMENT_BASE_NAME} ${suffix}${PASTED_TEXT_ATTACHMENT_EXTENSION}`,
    )
  ) {
    suffix += 1;
  }

  return `${PASTED_TEXT_ATTACHMENT_BASE_NAME} ${suffix}${PASTED_TEXT_ATTACHMENT_EXTENSION}`;
};

const hasFileDragData = (dataTransfer: DataTransfer | null): boolean => {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types).includes("Files")) return true;
  return Array.from(dataTransfer.items).some((item) => item.kind === "file");
};

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
    code === "STORAGE_LIMIT_EXCEEDED" ||
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
    desktopEnvironmentId,
  } = useGlobalState();
  const uploadedFilesRef = useRef(uploadedFiles);
  const activeTransfersRef = useRef(new Set<File>());
  const preferredStorageRegionPromiseRef = useRef<ReturnType<
    typeof getPreferredFileStorageRegion
  > | null>(null);

  useEffect(() => {
    uploadedFilesRef.current = uploadedFiles;
    for (const file of activeTransfersRef.current) {
      if (!uploadedFiles.some((item) => item.file === file)) {
        browserUploadTransfers.get(file)?.controller.abort();
      }
    }
  }, [uploadedFiles]);

  useEffect(() => {
    const activeTransfers = activeTransfersRef.current;
    return () => {
      for (const file of activeTransfers) {
        browserUploadTransfers.get(file)?.controller.abort();
        updateUploadedFile(file, {
          uploading: false,
          uploaded: false,
          retryable: false,
          error: "Upload interrupted. Remove and attach the file again.",
        });
      }
      activeTransfers.clear();
    };
  }, [updateUploadedFile]);

  // Drag and drop state
  const [isDragOver, setIsDragOver] = useState(false);
  const [showDragOverlay, setShowDragOverlay] = useState(false);
  const dragCounterRef = useRef(0);
  const fileDragActiveRef = useRef(false);

  // Track last shown rate limit warning to avoid spamming (show once per minute max)
  const lastRateLimitWarningRef = useRef<number>(0);

  const confirmDeletion = useDeletionConfirmation();
  const removingFilesRef = useRef(new Set<object>());
  const deleteFile = useMutation(api.fileStorage.deleteFile);
  const saveFile = useAction(api.fileActions.saveFile);
  const generateS3UploadUrlAction = useAction(
    api.s3Actions.generateS3UploadUrlAction,
  );

  const shouldUseLocalDesktopAttachments =
    isTauriEnvironment() &&
    isAgentMode(mode) &&
    (sandboxPreference === "desktop" ||
      (desktopEnvironmentId !== undefined &&
        sandboxPreference === `desktop-environment:${desktopEnvironmentId}`));

  const applyUploadedFileUpdate = useCallback(
    (indexToUpdate: number, updates: Partial<UploadedFileState>) => {
      const target = uploadedFilesRef.current[indexToUpdate]?.file;
      if (!target) return;
      uploadedFilesRef.current = uploadedFilesRef.current.map((file, index) =>
        index === indexToUpdate ? { ...file, ...updates } : file,
      );
      updateUploadedFile(target, updates);
    },
    [updateUploadedFile],
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
    (result: FileProcessingResult, hasRemainingSlots: boolean = true) => {
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
      options: {
        fallbackLocalFile?: LocalDesktopFile & { path: string };
        expectedGeneratedTextAttachment?: {
          previousFileId?: string;
          previousTokens?: number;
          previousUploadedFile?: UploadedFileState;
        };
      } = {},
    ) => {
      let transfer = browserUploadTransfers.get(file);
      if (transfer?.running) return;
      transfer ??= {
        controller: new AbortController(),
        running: false,
        retryable: false,
      };
      transfer.controller = new AbortController();
      transfer.running = true;
      transfer.retryable = false;
      browserUploadTransfers.set(file, transfer);
      activeTransfersRef.current.add(file);
      const { signal } = transfer.controller;
      const getCurrentUploadIndex = () => {
        if (signal.aborted) return null;
        const index = uploadedFilesRef.current.findIndex(
          (item) => item.file === file,
        );
        return index >= 0 ? index : null;
      };

      try {
        logLocalAttachmentDebug("s3-upload-start", {
          fileName: file.name,
          mode,
          sandboxPreference,
        });

        // Step 1: Generate presigned S3 upload URL in the closest configured
        // storage region. Region lookup failure safely uses legacy storage.
        if (!transfer.reservation) {
          preferredStorageRegionPromiseRef.current ??=
            getPreferredFileStorageRegion();
          const storageRegion = await preferredStorageRegionPromiseRef.current;
          signal.throwIfAborted();
          const reservation = await generateS3UploadUrlAction({
            fileName: file.name,
            contentType: file.type || "application/octet-stream",
            size: file.size,
            mode,
            ...(storageRegion ? { storageRegion } : {}),
          });
          transfer.reservation = reservation;
          if (reservation.rateLimit)
            showRateLimitWarning(reservation.rateLimit);
        }
        signal.throwIfAborted();
        const { uploadUrl, s3Key } = transfer.reservation;
        await putBrowserFile(file, uploadUrl, signal);
        signal.throwIfAborted();

        // Step 3: Save file metadata to database with S3 key
        const { url, fileId, tokens } = await saveFile({
          s3Key,
          name: file.name,
          mediaType: file.type,
          size: file.size,
          mode,
        });

        const currentUploadIndex = getCurrentUploadIndex();
        if (currentUploadIndex === null) {
          deleteFile({ fileId: fileId as Id<"files"> }).catch(console.error);
          return;
        }

        // Only check token limit for "ask" mode
        // In "agent" mode, files are accessed in sandbox, no token limit applies
        if (mode === "ask") {
          const currentTotal = Math.max(
            0,
            getTotalTokens() -
              (options.expectedGeneratedTextAttachment?.previousTokens ?? 0),
          );
          const newTotal = currentTotal + tokens;

          const maxFileTokens = getMaxFileTokens(subscription);
          if (newTotal > maxFileTokens) {
            // Exceeds limit - delete file from storage and remove from upload list
            deleteFile({ fileId: fileId as Id<"files"> }).catch(console.error);
            const previousUploadedFile =
              options.expectedGeneratedTextAttachment?.previousUploadedFile;
            if (previousUploadedFile) {
              applyUploadedFileUpdate(currentUploadIndex, {
                ...previousUploadedFile,
                error: `${file.name} exceeds the Ask mode token limit`,
              });
            } else {
              uploadedFilesRef.current = uploadedFilesRef.current.filter(
                (item) => item.file !== file,
              );
              removeUploadedFile(file);
            }

            toast.error(
              `${file.name} exceeds token limit (${newTotal.toLocaleString()}/${maxFileTokens.toLocaleString()} tokens). Tip: Switch to Agent mode to upload larger files.`,
            );
            return;
          }
        }

        // Set success state with tokens
        applyUploadedFileUpdate(currentUploadIndex, {
          tokens,
          error: undefined,
          retryable: false,
          uploading: false,
          uploaded: true,
          fileId,
          url,
        });

        const previousFileId =
          options.expectedGeneratedTextAttachment?.previousFileId;
        if (previousFileId && previousFileId !== fileId) {
          deleteFile({ fileId: previousFileId as Id<"files"> }).catch(
            console.error,
          );
        }
      } catch (error) {
        const currentUploadIndex = getCurrentUploadIndex();
        if (currentUploadIndex === null) {
          return;
        }

        if (
          getConvexErrorCode(error) === "FILE_UPLOAD_RATE_LIMIT" &&
          options.fallbackLocalFile
        ) {
          const fallbackFile = options.fallbackLocalFile;
          applyUploadedFileUpdate(currentUploadIndex, {
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

        const previousUploadedFile =
          options.expectedGeneratedTextAttachment?.previousUploadedFile;
        if (previousUploadedFile) {
          applyUploadedFileUpdate(currentUploadIndex, {
            ...previousUploadedFile,
            error: errorMessage,
          });
          toast.error(errorMessage);
          return;
        }

        transfer.retryable =
          error instanceof UploadTransportError && error.retryable;
        // Update the upload state to error
        applyUploadedFileUpdate(currentUploadIndex, {
          uploading: false,
          uploaded: false,
          error: errorMessage,
          retryable: transfer.retryable,
        });

        toast.error(errorMessage);
      } finally {
        transfer.running = false;
        if (!transfer.retryable) browserUploadTransfers.delete(file);
        activeTransfersRef.current.delete(file);
      }
    },
    [
      generateS3UploadUrlAction,
      saveFile,
      getTotalTokens,
      deleteFile,
      removeUploadedFile,
      applyUploadedFileUpdate,
      showRateLimitWarning,
      mode,
      sandboxPreference,
      subscription,
    ],
  );

  // Helper function to start file uploads
  const startFileUploads = useCallback(
    (
      files: File[],
      options: {
        generatedSource?: "pasted-text";
      } = {},
    ) => {
      files.forEach((selectedFile) => {
        const file = new File([selectedFile], selectedFile.name, {
          type: selectedFile.type,
          lastModified: selectedFile.lastModified,
        });
        const uploadedFile: UploadedFileState = {
          file,
          uploading: true,
          uploaded: false,
          storage: "s3",
          ...(options.generatedSource
            ? { generatedSource: options.generatedSource }
            : {}),
        };
        uploadedFilesRef.current = [...uploadedFilesRef.current, uploadedFile];
        addUploadedFile(uploadedFile);

        // Start upload in background
        void uploadFileToS3(file);
      });
    },
    [addUploadedFile, uploadFileToS3],
  );

  const processGeneratedPastedText = useCallback(
    async (content: string): Promise<boolean> => {
      const existingUploadedCount = uploadedFiles.length;
      const remainingSlots = maxFilesLimit - existingUploadedCount;
      const hasRemainingSlots = remainingSlots > 0;
      if (!hasRemainingSlots) {
        toast.error(
          `Maximum ${maxFilesLimit} files allowed. Please remove some files before adding more.`,
        );
        return false;
      }

      const fileName = getGeneratedPasteFileName(uploadedFiles);
      const attachmentId = createGeneratedTextAttachmentId();
      const file = createGeneratedTextFile(content, fileName);
      const result = await validateAndFilterFiles([file]);

      showProcessingFeedback(result, hasRemainingSlots);

      const validFile = result.validFiles[0];
      if (!validFile) {
        return false;
      }

      if (shouldUseLocalDesktopAttachments) {
        const localMetadata = await writeGeneratedTextAttachment(
          attachmentId,
          fileName,
          content,
        );
        if (!localMetadata) {
          return false;
        }

        const localFile = createGeneratedTextLocalFile(localMetadata, fileName);
        const generatedUploadedFile: UploadedFileState = {
          file: localFile,
          uploading: false,
          uploaded: true,
          storage: "local-desktop",
          generatedSource: "pasted-text",
          generatedTextAttachmentId: attachmentId,
          localAttachmentId: attachmentId,
          localPath: localMetadata.path,
          tokens: 0,
          generatedTextAttachment: {
            id: attachmentId,
            content,
          },
        };

        uploadedFilesRef.current = [
          ...uploadedFilesRef.current,
          generatedUploadedFile,
        ];
        addUploadedFile(generatedUploadedFile);
        logLocalAttachmentDebug("generated-text-local-file-added", {
          fileName: localFile.name,
          size: localFile.size,
          hasLocalPath: Boolean(localMetadata.path),
        });
        return true;
      }

      const generatedUploadedFile: UploadedFileState = {
        file: validFile,
        uploading: true,
        uploaded: false,
        storage: "s3",
        generatedSource: "pasted-text",
        generatedTextAttachment: {
          id: attachmentId,
          content,
        },
      };

      uploadedFilesRef.current = [
        ...uploadedFilesRef.current,
        generatedUploadedFile,
      ];
      addUploadedFile(generatedUploadedFile);

      void uploadFileToS3(validFile);

      return true;
    },
    [
      addUploadedFile,
      maxFilesLimit,
      showProcessingFeedback,
      uploadFileToS3,
      uploadedFiles,
      validateAndFilterFiles,
      shouldUseLocalDesktopAttachments,
    ],
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
      files.forEach((entry) => {
        if (entry.storage === "s3") {
          const uploadedFile: UploadedFileState = {
            file: entry.file,
            uploading: true,
            uploaded: false,
            storage: "s3",
          };
          uploadedFilesRef.current = [
            ...uploadedFilesRef.current,
            uploadedFile,
          ];
          addUploadedFile(uploadedFile);
          void uploadFileToS3(entry.file, {
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
    [addUploadedFile, uploadFileToS3],
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
    async (
      files: File[],
      options: {
        generatedSource?: "pasted-text";
      } = {},
    ): Promise<boolean> => {
      // Check if user has pro plan for file uploads
      if (subscription === "free") {
        toast.error("Upgrade plan to upload files.");
        return false;
      }

      const result = await validateAndFilterFiles(files);

      // Check if we have slots available
      const existingUploadedCount = uploadedFiles.length;
      const remainingSlots = maxFilesLimit - existingUploadedCount;
      const hasRemainingSlots = remainingSlots > 0;

      // Show feedback messages
      showProcessingFeedback(result, hasRemainingSlots);

      // Start uploads for valid files
      if (result.validFiles.length > 0 && hasRemainingSlots) {
        startFileUploads(result.validFiles, options);
        return true;
      }

      return false;
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

    await processFiles(Array.from(selectedFiles));

    // Clear the input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleRemoveFile = async (indexToRemove: number) => {
    const uploadedFile = uploadedFilesRef.current[indexToRemove];
    if (!uploadedFile || removingFilesRef.current.has(uploadedFile.file))
      return;
    removingFilesRef.current.add(uploadedFile.file);
    if (uploadedFile.file instanceof File)
      browserUploadTransfers.get(uploadedFile.file)?.controller.abort();
    try {
      if (uploadedFile.fileId && uploadedFile.storage !== "local-desktop") {
        const fileId = uploadedFile.fileId as Id<"files">;
        await confirmDeletion(
          () => deleteFile({ fileId }),
          { fileId },
          "Removing file…",
        );
      }
      if (
        uploadedFile.storage === "local-desktop" &&
        uploadedFile.generatedSource === "pasted-text"
      ) {
        const attachmentId =
          uploadedFile.generatedTextAttachment?.id ||
          uploadedFile.generatedTextAttachmentId ||
          uploadedFile.localAttachmentId;
        if (attachmentId && isTauriEnvironment()) {
          const removed = await removeGeneratedTextAttachment(
            attachmentId,
            uploadedFile.file.name,
          );
          if (!removed)
            throw new Error("Failed to remove pasted text attachment");
        }
      }
      const currentIndex = uploadedFilesRef.current.findIndex(
        (item) => item.file === uploadedFile.file,
      );
      if (currentIndex !== -1) {
        uploadedFilesRef.current = uploadedFilesRef.current.filter(
          (item) => item.file !== uploadedFile.file,
        );
        removeUploadedFile(uploadedFile.file);
      }
    } catch (error) {
      console.error("Failed to delete file from storage:", error);
      toast.error(
        error instanceof Error
          ? error.message
          : "Failed to delete file from storage",
      );
    } finally {
      removingFilesRef.current.delete(uploadedFile.file);
    }
  };

  const handleRetryFile = (index: number) => {
    const item = uploadedFilesRef.current[index];
    if (
      !item ||
      !(item.file instanceof File) ||
      item.generatedSource ||
      item.generatedTextAttachment ||
      !item.retryable ||
      item.uploading
    )
      return;
    const transfer = browserUploadTransfers.get(item.file);
    if (!transfer?.retryable || transfer.running) return;
    applyUploadedFileUpdate(index, {
      error: undefined,
      retryable: false,
      uploading: true,
      uploaded: false,
    });
    void uploadFileToS3(item.file);
  };

  const handleUpdateGeneratedTextFile = useCallback(
    (indexToUpdate: number, content: string) => {
      const uploadedFile = uploadedFilesRef.current[indexToUpdate];
      const generatedTextAttachment = uploadedFile?.generatedTextAttachment;

      if (!uploadedFile || !generatedTextAttachment) {
        return;
      }

      if (
        content === generatedTextAttachment.content &&
        uploadedFile.uploaded &&
        !uploadedFile.uploading &&
        !uploadedFile.error
      ) {
        return;
      }

      const nextFile = createGeneratedTextFile(content, uploadedFile.file.name);
      const previousFileId =
        uploadedFile.storage !== "local-desktop"
          ? uploadedFile.fileId
          : undefined;
      const previousTokens = uploadedFile.tokens;

      if (uploadedFile.storage === "local-desktop") {
        const generatedTextAttachmentId =
          generatedTextAttachment.id ||
          uploadedFile.generatedTextAttachmentId ||
          uploadedFile.localAttachmentId;
        if (!generatedTextAttachmentId) {
          return;
        }

        const getCurrentLocalTextIndex = () =>
          uploadedFilesRef.current.findIndex((currentFile) => {
            const currentGeneratedId =
              currentFile.generatedTextAttachment?.id ||
              currentFile.generatedTextAttachmentId ||
              currentFile.localAttachmentId;

            return (
              currentGeneratedId === generatedTextAttachmentId &&
              currentFile.generatedTextAttachment?.content === content
            );
          });

        const pendingUploadedFile: UploadedFileState = {
          ...uploadedFile,
          file: {
            name: uploadedFile.file.name,
            type: uploadedFile.file.type || TEXT_PLAIN_MEDIA_TYPE,
            size: nextFile.size,
            lastModified: nextFile.lastModified,
          },
          uploading: true,
          uploaded: false,
          error: undefined,
          storage: "local-desktop",
          generatedSource: "pasted-text",
          generatedTextAttachmentId,
          localAttachmentId:
            uploadedFile.localAttachmentId || generatedTextAttachmentId,
          tokens: 0,
          generatedTextAttachment: {
            id: generatedTextAttachmentId,
            content,
          },
        };

        applyUploadedFileUpdate(indexToUpdate, pendingUploadedFile);

        writeGeneratedTextAttachment(
          generatedTextAttachmentId,
          uploadedFile.file.name,
          content,
        )
          .then((localMetadata) => {
            const currentIndex = getCurrentLocalTextIndex();
            if (currentIndex < 0) {
              return;
            }

            if (!localMetadata) {
              applyUploadedFileUpdate(currentIndex, {
                ...uploadedFile,
                error: "Failed to save pasted text locally",
              });
              return;
            }

            const updatedUploadedFile: UploadedFileState = {
              ...pendingUploadedFile,
              file: createGeneratedTextLocalFile(
                localMetadata,
                uploadedFile.file.name,
              ),
              uploading: false,
              uploaded: true,
              localPath: localMetadata.path,
              tokens: 0,
            };

            applyUploadedFileUpdate(currentIndex, updatedUploadedFile);
          })
          .catch((error) => {
            console.error("Failed to update local generated text file:", error);
            const currentIndex = getCurrentLocalTextIndex();
            if (currentIndex >= 0) {
              applyUploadedFileUpdate(currentIndex, {
                ...uploadedFile,
                error: "Failed to save pasted text locally",
              });
            }
            toast.error("Failed to save pasted text locally");
          });
        return;
      }

      const updatedUploadedFile: UploadedFileState = {
        ...uploadedFile,
        file: nextFile,
        uploading: true,
        uploaded: false,
        error: undefined,
        storage: "s3",
        generatedSource: "pasted-text",
        fileId: previousFileId,
        tokens: previousTokens,
        generatedTextAttachment: {
          id: generatedTextAttachment.id,
          content,
        },
      };

      applyUploadedFileUpdate(indexToUpdate, updatedUploadedFile);

      void uploadFileToS3(nextFile, {
        expectedGeneratedTextAttachment: {
          previousFileId,
          previousTokens,
          previousUploadedFile: uploadedFile,
        },
      });
    },
    [applyUploadedFileUpdate, uploadFileToS3],
  );

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

  const handlePastedTextAttachment = useCallback(
    async (text: string): Promise<boolean> => {
      if (subscription === "free" || !isAgentMode(mode) || !text.trim()) {
        return false;
      }

      const started = await processGeneratedPastedText(text);
      if (started) {
        toast.info("Pasted text added as an attachment");
      }
      return started;
    },
    [mode, processGeneratedPastedText, subscription],
  );

  const handlePasteEvent = async (event: ClipboardEvent): Promise<boolean> => {
    const items = event.clipboardData?.items;
    const pastedText = getClipboardPlainText(event);

    if (
      pastedText.length >= PASTED_TEXT_ATTACHMENT_MIN_CHARS &&
      !pastedText.trim()
    ) {
      event.preventDefault();
      toast.info("No readable text was added from the paste.");
      return true;
    }

    if (
      subscription !== "free" &&
      isAgentMode(mode) &&
      pastedText.length >= PASTED_TEXT_ATTACHMENT_MIN_CHARS &&
      (!items || Array.from(items).every((item) => item.kind !== "file"))
    ) {
      event.preventDefault();
      await handlePastedTextAttachment(pastedText);
      return true;
    }

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

    await processFiles(files);
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
    if (!hasFileDragData(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();

    fileDragActiveRef.current = true;
    dragCounterRef.current++;

    setShowDragOverlay(true);
  }, []);

  const handleDragLeave = useCallback((e: DragEvent) => {
    if (!fileDragActiveRef.current && !hasFileDragData(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();

    dragCounterRef.current = Math.max(0, dragCounterRef.current - 1);

    if (dragCounterRef.current === 0) {
      fileDragActiveRef.current = false;
      setShowDragOverlay(false);
      setIsDragOver(false);
    }
  }, []);

  const handleDragOver = useCallback((e: DragEvent) => {
    if (!fileDragActiveRef.current && !hasFileDragData(e.dataTransfer)) return;

    e.preventDefault();
    e.stopPropagation();

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = "copy";
    }

    setIsDragOver(true);
  }, []);

  const handleDrop = useCallback(
    async (e: DragEvent) => {
      if (!fileDragActiveRef.current && !hasFileDragData(e.dataTransfer)) {
        return;
      }

      e.preventDefault();
      e.stopPropagation();

      // Reset drag state
      fileDragActiveRef.current = false;
      setShowDragOverlay(false);
      setIsDragOver(false);
      dragCounterRef.current = 0;

      const files = e.dataTransfer?.files;
      if (!files || files.length === 0) return;

      await processFiles(Array.from(files));
    },
    [processFiles],
  );

  return {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleRetryFile,
    handleUpdateGeneratedTextFile,
    handleAttachClick,
    handlePasteEvent,
    handlePastedTextAttachment,
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
