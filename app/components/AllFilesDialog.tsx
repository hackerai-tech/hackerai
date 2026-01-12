"use client";

import React, { useState, useEffect } from "react";
import { X, Download, Circle, CircleCheck, File } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConvex, useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useFileUrlCacheContext } from "@/app/contexts/FileUrlCacheContext";
import type { FilePart } from "@/types/file";
import JSZip from "jszip";
import { toast } from "sonner";
import { isTauriEnvironment, openDownloadsFolder } from "@/app/hooks/useTauri";

interface AllFilesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  files: Array<{
    part: FilePart;
    partIndex: number;
    messageId: string;
  }>;
  chatTitle?: string | null;
}

interface FileItemProps {
  file: {
    part: FilePart;
    partIndex: number;
    messageId: string;
  };
  isSelected: boolean;
  selectionMode: boolean;
  onToggle: () => void;
  fileUrl: string | null;
}

const FileItem = ({
  file,
  isSelected,
  selectionMode,
  onToggle,
  fileUrl,
}: FileItemProps) => {
  const fileName = file.part.name || file.part.filename || "Unknown file";

  const handleDownload = async () => {
    if (!fileUrl) return;

    try {
      const response = await fetch(fileUrl);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);

      if (isTauriEnvironment()) {
        toast.success(`Downloaded ${fileName}`, {
          description: "Saved to Downloads folder",
          action: {
            label: "Show in folder",
            onClick: () => openDownloadsFolder(),
          },
        });
      }
    } catch (error) {
      console.error("Error downloading file:", error);
      toast.error("Failed to download file");
    }
  };

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-secondary transition-colors rounded-lg ${
        selectionMode ? "cursor-pointer" : ""
      }`}
      onClick={selectionMode ? onToggle : undefined}
    >
      {selectionMode && (
        <Button
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          variant="ghost"
          size="icon"
          className="h-5 w-5 p-0 hover:opacity-85"
          type="button"
          aria-label={`${isSelected ? "Deselect" : "Select"} file`}
        >
          {isSelected ? (
            <CircleCheck className="w-5 h-5" />
          ) : (
            <Circle className="w-5 h-5 text-muted-foreground" />
          )}
        </Button>
      )}

      <div className="relative flex items-center justify-center w-10 h-10 rounded-lg bg-[#FF5588]">
        <File className="w-6 h-6 text-white" />
      </div>

      <div className="flex flex-col gap-1 flex-grow flex-1 min-w-0">
        <div className="flex justify-between items-center flex-1 min-w-0">
          <div className="flex flex-col flex-1 min-w-0 max-w-full">
            <div className="flex-1 min-w-0 flex gap-2 items-center">
              <span
                className="inline-block whitespace-nowrap text-sm text-foreground"
                style={{ overflow: "hidden", textOverflow: "ellipsis" }}
              >
                {fileName}
              </span>
            </div>
          </div>
        </div>
      </div>

      {!selectionMode && fileUrl && (
        <Button
          onClick={handleDownload}
          variant="ghost"
          size="icon"
          className="h-6 w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity"
          type="button"
          aria-label="Download file"
        >
          <Download className="w-4 h-4 text-muted-foreground" />
        </Button>
      )}
    </div>
  );
};

const AllFilesDialog = ({
  open,
  onOpenChange,
  files,
  chatTitle,
}: AllFilesDialogProps) => {
  const convex = useConvex();
  const getFileUrlAction = useAction(api.s3Actions.getFileUrlAction);
  const fileUrlCache = useFileUrlCacheContext();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileUrls, setFileUrls] = useState<Map<number, string>>(new Map());
  const [isLoadingUrls, setIsLoadingUrls] = useState(false);

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      setFileUrls(new Map());
      setIsLoadingUrls(false);
      setSelectionMode(false);
      setSelectedFiles(new Set());
    }
    onOpenChange(newOpen);
  };

  // Batch fetch all URLs when dialog opens
  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;

    async function fetchAllUrls() {
      if (cancelled) return;
      setIsLoadingUrls(true);
      const urlMap = new Map<number, string>();

      // Fetch URLs in parallel
      await Promise.all(
        files.map(async (file, index) => {
          // If already has URL, use it
          if (file.part.url) {
            urlMap.set(index, file.part.url);
            return;
          }

          // Check cache first for fileId
          if (file.part.fileId && fileUrlCache) {
            const cachedUrl = fileUrlCache.getCachedUrl(file.part.fileId);
            if (cachedUrl) {
              urlMap.set(index, cachedUrl);
              return;
            }
          }

          // Fetch URL based on storage type
          try {
            let url: string | null = null;

            if (file.part.fileId) {
              // S3 file - fetch presigned URL
              url = await getFileUrlAction({ fileId: file.part.fileId });
              // Cache it
              if (url && fileUrlCache) {
                fileUrlCache.setCachedUrl(file.part.fileId, url);
              }
            } else if (file.part.storageId) {
              // Convex storage file - fetch URL
              url = await convex.query(api.fileStorage.getFileDownloadUrl, {
                storageId: file.part.storageId,
              });
            }

            if (url) {
              urlMap.set(index, url);
            }
          } catch (error) {
            console.error(`Failed to fetch URL for file ${index}:`, error);
          }
        }),
      );

      if (!cancelled) {
        setFileUrls(urlMap);
        setIsLoadingUrls(false);
      }
    }

    fetchAllUrls();

    return () => {
      cancelled = true;
    };
  }, [open, files, getFileUrlAction, convex, fileUrlCache]);

  const handleEnterSelectionMode = () => {
    setSelectionMode(true);
    // Select all files by default
    const allFileIds = new Set(files.map((_, index) => index.toString()));
    setSelectedFiles(allFileIds);
  };

  const handleCancelSelection = () => {
    setSelectionMode(false);
    setSelectedFiles(new Set());
  };

  const handleToggleAll = () => {
    if (selectedFiles.size === files.length) {
      setSelectedFiles(new Set());
    } else {
      const allFileIds = new Set(files.map((_, index) => index.toString()));
      setSelectedFiles(allFileIds);
    }
  };

  const handleToggleFile = (fileId: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(fileId)) {
      newSelected.delete(fileId);
    } else {
      newSelected.add(fileId);
    }
    setSelectedFiles(newSelected);
  };

  const handleBatchDownload = async () => {
    const filesToDownload = files
      .map((file, index) => ({ file, index }))
      .filter(({ index }) => selectedFiles.has(index.toString()));

    if (filesToDownload.length === 0) return;

    try {
      const zip = new JSZip();

      // Use already fetched URLs or fetch missing ones
      await Promise.all(
        filesToDownload.map(async ({ file, index }) => {
          try {
            let url = fileUrls.get(index) || file.part.url;

            // Fetch URL if not already available
            if (!url) {
              if (file.part.fileId) {
                url = await getFileUrlAction({ fileId: file.part.fileId });
              } else if (file.part.storageId) {
                const fetchedUrl = await convex.query(
                  api.fileStorage.getFileDownloadUrl,
                  {
                    storageId: file.part.storageId,
                  },
                );
                url = fetchedUrl || undefined;
              }
            }

            if (url) {
              const response = await fetch(url);
              const blob = await response.blob();
              const fileName =
                file.part.name ||
                file.part.filename ||
                `file-${file.partIndex}`;
              zip.file(fileName, blob);
            }
          } catch (error) {
            console.error(`Error adding ${file.part.name} to ZIP:`, error);
          }
        }),
      );

      // Generate the ZIP file
      const zipBlob = await zip.generateAsync({ type: "blob" });

      // Download the ZIP file
      const blobUrl = URL.createObjectURL(zipBlob);
      const link = document.createElement("a");
      link.href = blobUrl;

      // Create filename from chat title or use fallback
      let fileName = "chat-files";
      if (chatTitle) {
        // Sanitize the title for use in filename
        fileName = chatTitle
          .replace(/[^a-zA-Z0-9-_ ]/g, "") // Remove invalid characters
          .replace(/\s+/g, "-") // Replace spaces with hyphens
          .substring(0, 50); // Limit length
      }
      if (!fileName || fileName === "") {
        const timestamp = new Date().toISOString().split("T")[0];
        fileName = `chat-files-${timestamp}`;
      }

      link.download = `${fileName}.zip`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(blobUrl);

      if (isTauriEnvironment()) {
        toast.success(`Downloaded ${filesToDownload.length} files`, {
          description: `Saved as ${fileName}.zip to Downloads folder`,
          action: {
            label: "Show in folder",
            onClick: () => openDownloadsFolder(),
          },
        });
      } else {
        toast.success(
          `Downloaded ${filesToDownload.length} files as ${fileName}.zip`,
        );
      }
    } catch (error) {
      console.error("Error creating ZIP file:", error);
      toast.error("Failed to create ZIP file");
    }

    // Exit selection mode after download
    handleCancelSelection();
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="bg-background rounded-[20px] border border-border fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 max-w-[95%] max-h-[95%] overflow-auto h-[680px] flex flex-col p-0"
        style={{ width: "600px" }}
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">All files in this chat</DialogTitle>
        {selectionMode ? (
          <header className="flex items-center justify-between pt-6 pr-6 pl-6 pb-2.5">
            <Button
              onClick={handleToggleAll}
              variant="ghost"
              className="flex items-center gap-2.5 text-sm text-muted-foreground hover:opacity-85 h-auto p-0"
              type="button"
            >
              {selectedFiles.size === files.length ? (
                <CircleCheck className="w-5 h-5" />
              ) : (
                <Circle className="w-5 h-5 text-muted-foreground" />
              )}
              Select all
            </Button>
            <Button
              onClick={handleCancelSelection}
              variant="ghost"
              className="text-muted-foreground hover:opacity-85 text-sm h-auto p-0"
              type="button"
            >
              Cancel
            </Button>
          </header>
        ) : (
          <header className="flex items-center pt-6 pr-6 pl-6 pb-2.5">
            <h1 className="flex-1 text-foreground text-lg font-semibold">
              All files in this chat
            </h1>
            <div className="flex items-center gap-2">
              <Button
                onClick={handleEnterSelectionMode}
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Download files"
                type="button"
              >
                <Download className="size-5 text-muted-foreground" />
              </Button>
              <Button
                onClick={() => handleOpenChange(false)}
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                aria-label="Close dialog"
                type="button"
              >
                <X className="size-5 text-muted-foreground" />
              </Button>
            </div>
          </header>
        )}

        <div className="flex-1 min-h-0 overflow-auto px-6 pt-4 pb-4">
          <div className="flex flex-col gap-0">
            {files.length === 0 ? (
              <div className="text-center text-muted-foreground py-8">
                No files
              </div>
            ) : isLoadingUrls ? (
              <div className="text-center text-muted-foreground py-8">
                Loading files...
              </div>
            ) : (
              files.map((file, index) => {
                const fileId = index.toString();
                const isSelected = selectedFiles.has(fileId);
                const fileUrl = fileUrls.get(index) || file.part.url || null;

                return (
                  <FileItem
                    key={`${file.messageId}-${file.partIndex}`}
                    file={file}
                    isSelected={isSelected}
                    selectionMode={selectionMode}
                    onToggle={() => handleToggleFile(fileId)}
                    fileUrl={fileUrl}
                  />
                );
              })
            )}
          </div>
        </div>

        {selectionMode && (
          <footer className="px-5 py-4 border-t border-border flex justify-end">
            <Button
              onClick={handleBatchDownload}
              variant="outline"
              className="h-9 px-3 rounded-full"
              disabled={selectedFiles.size === 0}
              type="button"
            >
              <Download className="w-[18px] h-[18px] text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                Batch download ({selectedFiles.size})
              </span>
            </Button>
          </footer>
        )}
      </DialogContent>
    </Dialog>
  );
};

export { AllFilesDialog };
