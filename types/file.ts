export interface FileMessagePart {
  type: "file";
  mediaType: string;
  storageId: string;
  name: string;
  size: number;
  url: string; // Always include URL for immediate rendering
}

export interface FileUIObject {
  type: "file";
  filename: string;
  mediaType: string;
  url: string;
  storageId: string;
}

export interface UploadedFileState {
  file: File;
  uploading: boolean;
  uploaded: boolean;
  error?: string;
  storageId?: string;
  url?: string; // Store the resolved URL
}
