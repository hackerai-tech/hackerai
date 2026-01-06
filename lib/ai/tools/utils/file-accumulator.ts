import type { Id } from "@/convex/_generated/dataModel";

export interface AccumulatedFileMetadata {
  fileId: Id<"files">;
  name: string;
  mediaType: string;
  s3Key?: string;
  storageId?: Id<"_storage">;
}

export class FileAccumulator {
  private files: Map<Id<"files">, AccumulatedFileMetadata> = new Map();

  add(metadata: AccumulatedFileMetadata) {
    this.files.set(metadata.fileId, metadata);
  }

  addMany(metadataList: Array<AccumulatedFileMetadata>) {
    for (const metadata of metadataList) {
      this.files.set(metadata.fileId, metadata);
    }
  }

  /** Get all file IDs (for backward compatibility) */
  getAllIds(): Array<Id<"files">> {
    return Array.from(this.files.keys());
  }

  /** Get all file metadata */
  getAll(): Array<AccumulatedFileMetadata> {
    return Array.from(this.files.values());
  }

  clear() {
    this.files.clear();
  }
}
