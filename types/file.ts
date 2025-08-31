export interface FileMessagePart {
  type: "file";
  mediaType: string;
  storageId: string;
  name: string;
  size: number;
  url: string; // Always include URL for immediate rendering
}

export interface UploadedFileState {
  file: File;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
  storageId?: string;
  url?: string; // Store the resolved URL
}

// File part interface for rendering components
export interface FilePart {
  url?: string;
  storageId?: string;
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
