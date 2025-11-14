/**
 * File API Adapter - Boundary Adapter Pattern
 *
 * This module provides a defensive abstraction layer between the browser's
 * File API and the application. It normalizes unreliable browser behavior
 * and enforces data quality guarantees.
 *
 * Design Principles:
 * - Never trust external APIs without validation
 * - Normalize data at system boundaries
 * - Provide fallback mechanisms for missing/invalid data
 * - Make implicit contracts explicit through types
 *
 * @module file-api-adapter
 */

import { inferMimeTypeFromFileName } from "@/convex/constants";

/**
 * Normalized File metadata with guaranteed properties
 * Unlike browser File objects, this type guarantees all metadata is valid
 */
export interface NormalizedFileMetadata {
  name: string;
  size: number;
  contentType: string; // Guaranteed non-empty
  lastModified: number;
  wasContentTypeInferred: boolean; // True if we had to infer from extension
}

/**
 * Result of file normalization process
 */
export interface FileNormalizationResult {
  metadata: NormalizedFileMetadata;
  originalFile: File;
  warnings: string[];
}

/**
 * File source types for tracking where files come from
 */
export type FileSource = "upload" | "paste" | "drop" | "unknown";

/**
 * Statistics about file normalization operations
 */
export interface FileAdapterStats {
  totalFilesProcessed: number;
  contentTypeInferredCount: number;
  emptyFileNameCount: number;
  invalidSizeCount: number;
}

/**
 * File API Adapter - Main class
 *
 * Provides defensive normalization of browser File objects
 */
export class FileApiAdapter {
  private stats: FileAdapterStats = {
    totalFilesProcessed: 0,
    contentTypeInferredCount: 0,
    emptyFileNameCount: 0,
    invalidSizeCount: 0,
  };

  /**
   * Normalize a browser File object into validated metadata
   *
   * This is the main entry point - all File objects from the browser
   * should pass through this function before entering the application
   *
   * @param file - Browser File object (untrusted)
   * @param source - Where the file came from (for logging/debugging)
   * @returns Normalized metadata with guarantees
   */
  normalizeFile(
    file: File,
    source: FileSource = "unknown",
  ): FileNormalizationResult {
    this.stats.totalFilesProcessed++;

    const warnings: string[] = [];
    let contentType = file.type;
    let wasInferred = false;

    // Defensive: Check if browser provided MIME type
    if (!contentType || contentType.trim().length === 0) {
      contentType = inferMimeTypeFromFileName(file.name);
      wasInferred = true;
      this.stats.contentTypeInferredCount++;

      warnings.push(
        `Browser did not provide MIME type for "${file.name}" (source: ${source}), inferred as "${contentType}"`,
      );
    }

    // Defensive: Validate file name
    if (!file.name || file.name.trim().length === 0) {
      this.stats.emptyFileNameCount++;
      warnings.push("File has empty name - this is unusual");
    }

    // Defensive: Validate file size
    if (file.size < 0) {
      this.stats.invalidSizeCount++;
      warnings.push(`File has invalid size: ${file.size}`);
    }

    const metadata: NormalizedFileMetadata = {
      name: file.name,
      size: file.size,
      contentType,
      lastModified: file.lastModified || Date.now(),
      wasContentTypeInferred: wasInferred,
    };

    return {
      metadata,
      originalFile: file,
      warnings,
    };
  }

  /**
   * Normalize multiple files at once
   *
   * @param files - Array of browser File objects
   * @param source - Where the files came from
   * @returns Array of normalization results
   */
  normalizeFiles(
    files: File[],
    source: FileSource = "unknown",
  ): FileNormalizationResult[] {
    return files.map((file) => this.normalizeFile(file, source));
  }

  /**
   * Get content type for a file (convenience method)
   *
   * @param file - Browser File object
   * @returns Guaranteed non-empty MIME type
   */
  getContentType(file: File): string {
    const result = this.normalizeFile(file);
    return result.metadata.contentType;
  }

  /**
   * Check if file is an image based on normalized MIME type
   *
   * @param file - Browser File object
   * @returns True if image type
   */
  isImage(file: File): boolean {
    const contentType = this.getContentType(file);
    return contentType.startsWith("image/");
  }

  /**
   * Get statistics about normalization operations
   * Useful for monitoring and debugging
   *
   * @returns Current statistics
   */
  getStats(): Readonly<FileAdapterStats> {
    return { ...this.stats };
  }

  /**
   * Reset statistics (useful for testing)
   */
  resetStats(): void {
    this.stats = {
      totalFilesProcessed: 0,
      contentTypeInferredCount: 0,
      emptyFileNameCount: 0,
      invalidSizeCount: 0,
    };
  }

  /**
   * Log statistics to console
   * Call this periodically or on errors to understand File API behavior
   */
  logStats(): void {
    console.log("File API Adapter Statistics:", {
      ...this.stats,
      inferenceRate:
        this.stats.totalFilesProcessed > 0
          ? (
              (this.stats.contentTypeInferredCount /
                this.stats.totalFilesProcessed) *
              100
            ).toFixed(1) + "%"
          : "N/A",
    });
  }
}

/**
 * Singleton instance for convenience
 * Most code should use this instead of creating new instances
 */
export const fileAdapter = new FileApiAdapter();

/**
 * Convenience functions that use the singleton instance
 */

/**
 * Normalize a single file using the singleton adapter
 */
export function normalizeFile(
  file: File,
  source?: FileSource,
): FileNormalizationResult {
  return fileAdapter.normalizeFile(file, source);
}

/**
 * Normalize multiple files using the singleton adapter
 */
export function normalizeFiles(
  files: File[],
  source?: FileSource,
): FileNormalizationResult[] {
  return fileAdapter.normalizeFiles(files, source);
}

/**
 * Get content type using the singleton adapter
 */
export function getContentType(file: File): string {
  return fileAdapter.getContentType(file);
}

/**
 * Check if file is an image using the singleton adapter
 */
export function isImage(file: File): boolean {
  return fileAdapter.isImage(file);
}

/**
 * Get statistics from the singleton adapter
 */
export function getFileAdapterStats(): Readonly<FileAdapterStats> {
  return fileAdapter.getStats();
}

/**
 * Log statistics from the singleton adapter
 */
export function logFileAdapterStats(): void {
  fileAdapter.logStats();
}
