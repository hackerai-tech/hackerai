import { Id } from "@/convex/_generated/dataModel";

export interface FileMessagePart {
  type: "file";
  mediaType: string;
  fileId: string; // Database file ID for backend operations
  name: string;
  size: number;
  // DON'T store URL in message parts - S3 URLs expire!
  // URLs are generated on-demand via fileId
  // url: string;
}

export interface UploadedFileState {
  file: File;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
  fileId?: string; // Database file ID for backend operations
  url?: string; // Store the resolved URL
  tokens?: number; // Token count for the file
}

// File part interface for rendering components
export interface FilePart {
  url?: string;
  fileId?: Id<"files">; // Database file ID for fetching URLs via action
  name?: string;
  filename?: string;
  mediaType?: string;
  storageId?: string; // Storage ID for on-demand URL fetching (Convex files)
  s3Key?: string; // S3 key for on-demand URL fetching (S3 files)
}

// Props for FilePartRenderer component
export interface FilePartRendererProps {
  part: FilePart;
  partIndex: number;
  messageId: string;
  totalFileParts?: number;
}

// File upload preview interfaces
export interface FileUploadPreviewProps {
  uploadedFiles: UploadedFileState[];
  onRemoveFile: (index: number) => void;
}

export interface FilePreview {
  file: File;
  preview?: string;
  loading: boolean;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
}

// File processing types
export type FileProcessingResult = {
  validFiles: File[];
  invalidFiles: string[];
  truncated: boolean;
  processedCount: number;
};

export type FileSource = "upload" | "paste" | "drop";

// File processing chunk interface
export interface FileItemChunk {
  content: string;
  tokens: number;
}

// Supported file types for processing
export type SupportedFileType = "pdf" | "csv" | "json" | "txt" | "md" | "docx";

export interface ProcessFileOptions {
  fileType: SupportedFileType;
  prepend?: string; // For markdown files
  fileName?: string; // For file type detection (e.g., .doc vs .docx)
}

// File details type for assistant-generated files in messages
export interface FileDetails {
  fileId: Id<"files">;
  name: string;
  mediaType?: string;
  url?: string | null;
  storageId?: string;
  s3Key?: string;
}

/**
 * File content returned by getFileContentByFileIds query
 * Used for processing file content in ask mode
 */
export interface FileContent {
  id: Id<"files">;
  name: string;
  mediaType: string;
  content: string | null;
  tokenSize: number;
}
