import { useRef } from "react";
import { toast } from "sonner";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { MAX_FILES_LIMIT, uploadSingleFileToConvex, validateFile, type UploadedFileState, createFileMessagePartFromUploadedFile } from "@/lib/utils/file-utils";
import { useGlobalState } from "../contexts/GlobalState";

export const useFileUpload = () => {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { uploadedFiles, addUploadedFile, updateUploadedFile, removeUploadedFile } = useGlobalState();
  
  const generateUploadUrl = useMutation(api.messages.generateUploadUrl);
  const deleteFile = useMutation(api.messages.deleteFile);
  const getFileUrl = useMutation(api.messages.getFileUrls);

  const uploadFileToConvex = async (file: File, uploadIndex: number) => {
    try {
      const storageId = await uploadSingleFileToConvex(
        file,
        generateUploadUrl
      );

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
      toast.error(`Failed to upload ${file.name}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  };

  const handleFileUploadEvent = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const selectedFiles = event.target.files;
    if (!selectedFiles || selectedFiles.length === 0) return;

    // Check file limits and validation first
    const existingUploadedCount = uploadedFiles.length;
    const newFilesArray = Array.from(selectedFiles);
    let filesToProcess = newFilesArray;
    let truncated = false;

    // Check if we would exceed the limit
    const totalFiles = existingUploadedCount + newFilesArray.length;
    if (totalFiles > MAX_FILES_LIMIT) {
      const remainingSlots = MAX_FILES_LIMIT - existingUploadedCount;
      if (remainingSlots <= 0) {
        toast.error(
          `Maximum ${MAX_FILES_LIMIT} files allowed. Please remove some files before adding more.`
        );
        return;
      }
      filesToProcess = newFilesArray.slice(0, remainingSlots);
      truncated = true;
    }

    // Validate and process each file
    const invalidFiles: string[] = [];
    for (const file of filesToProcess) {
      const validation = validateFile(file);
      if (!validation.valid) {
        invalidFiles.push(`${file.name}: ${validation.error}`);
        continue;
      }

      // Add file as "uploading" state immediately
      const uploadState: UploadedFileState = {
        file,
        uploading: true,
        uploaded: false,
      };
      addUploadedFile(uploadState);

      // Start upload in background
      const uploadIndex = uploadedFiles.length + filesToProcess.indexOf(file);
      uploadFileToConvex(file, uploadIndex);
    }

    // Show error messages if any
    const messages: string[] = [];
    if (truncated) {
      messages.push(
        `Only ${filesToProcess.length} files were added. Maximum ${MAX_FILES_LIMIT} files allowed.`
      );
    }
    if (invalidFiles.length > 0) {
      messages.push(`Some files were invalid:\n${invalidFiles.join("\n")}`);
    }
    if (messages.length > 0) {
      toast.error(messages.join("\n\n"));
    }

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

  const handlePasteEvent = async (event: ClipboardEvent) => {
    const items = event.clipboardData?.items;
    if (!items) return;

    const files: File[] = [];
    
    // Check for any files in clipboard (images, documents, etc.)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      // Accept any file type, not just images
      if (item.kind === 'file') {
        const file = item.getAsFile();
        if (file) {
          files.push(file);
        }
      }
    }

    if (files.length === 0) return;

    // Check file limits and validation first
    const existingUploadedCount = uploadedFiles.length;
    let filesToProcess = files;
    let truncated = false;

    // Check if we would exceed the limit
    const totalFiles = existingUploadedCount + files.length;
    if (totalFiles > MAX_FILES_LIMIT) {
      const remainingSlots = MAX_FILES_LIMIT - existingUploadedCount;
      if (remainingSlots <= 0) {
        toast.error(
          `Maximum ${MAX_FILES_LIMIT} files allowed. Please remove some files before adding more.`
        );
        return;
      }
      filesToProcess = files.slice(0, remainingSlots);
      truncated = true;
    }

    // Validate and process each file
    const invalidFiles: string[] = [];
    for (const file of filesToProcess) {
      const validation = validateFile(file);
      if (!validation.valid) {
        invalidFiles.push(`${file.name}: ${validation.error}`);
        continue;
      }

      // Add file as "uploading" state immediately
      const uploadState: UploadedFileState = {
        file,
        uploading: true,
        uploaded: false,
      };
      addUploadedFile(uploadState);

      // Start upload in background
      const uploadIndex = uploadedFiles.length + filesToProcess.indexOf(file);
      uploadFileToConvex(file, uploadIndex);
    }

    // Show messages if any
    const messages: string[] = [];
    if (truncated) {
      messages.push(
        `Only ${filesToProcess.length} files were added. Maximum ${MAX_FILES_LIMIT} files allowed.`
      );
    }
    if (invalidFiles.length > 0) {
      messages.push(`Some files were invalid:\n${invalidFiles.join("\n")}`);
    }
    if (messages.length > 0) {
      toast.error(messages.join("\n\n"));
    } else if (filesToProcess.length > 0) {
      toast.success(`${filesToProcess.length} file${filesToProcess.length > 1 ? 's' : ''} pasted and uploading`);
    }
  };

  // Helper to get all uploaded file message parts for sending
  const getUploadedFileMessageParts = () => {
    return uploadedFiles
      .map(createFileMessagePartFromUploadedFile)
      .filter((part): part is NonNullable<typeof part> => part !== null);
  };

  // Helper to check if all files have finished uploading
  const allFilesUploaded = () => {
    return uploadedFiles.length > 0 && uploadedFiles.every(file => file.uploaded && !file.uploading);
  };

  // Helper to check if any files are currently uploading
  const anyFilesUploading = () => {
    return uploadedFiles.some(file => file.uploading);
  };

  return {
    fileInputRef,
    handleFileUploadEvent,
    handleRemoveFile,
    handleAttachClick,
    handlePasteEvent,
    getUploadedFileMessageParts,
    allFilesUploaded,
    anyFilesUploading,
  };
};
