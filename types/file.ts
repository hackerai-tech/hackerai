export interface FileMessagePart {
  type: "file";
  mediaType: string;
  fileId: string; // Database file ID for backend operations
  name: string;
  size: number;
  url: string; // Always include URL for immediate rendering
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
  fileId?: string;
  name?: string;
  filename?: string;
  mediaType?: string;
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
