"use client";

import React, { useState, useEffect, useCallback } from "react";
import { X, Download, Circle, CircleCheck, File } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAction } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useFileUrlCacheContext } from "@/app/contexts/FileUrlCacheContext";
import type { FilePart } from "@/types/file";
import JSZip from "jszip";
import { toast } from "sonner";
import { isTauriEnvironment, openDownloadsFolder } from "@/app/hooks/useTauri";
import { formatTaskTitle } from "@/app/utils/task-ui-copy";

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

type DialogFile = AllFilesDialogProps["files"][number];

const FILE_URL_BATCH_SIZE = 50;

interface FileItemProps {
  file: DialogFile;
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
  const getFileUrlsBatchAction = useAction(
    api.s3Actions.getFileUrlsBatchAction,
  );
  const fileUrlCache = useFileUrlCacheContext();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileUrls, setFileUrls] = useState<Map<number, string>>(new Map());
  const [isLoadingUrls, setIsLoadingUrls] = useState(false);

  const resolveFileUrls = useCallback(
    async (
      items: Array<{
        file: DialogFile;
        index: number;
      }>,
    ): Promise<Map<number, string>> => {
      const urlMap = new Map<number, string>();
      const pendingByFileId = new Map<
        string,
        { fileId: Id<"files">; indexes: number[] }
      >();

      for (const { file, index } of items) {
        if (file.part.url) {
          urlMap.set(index, file.part.url);
          continue;
        }

        if (!file.part.fileId) {
          continue;
        }

        const cachedUrl = fileUrlCache?.getCachedUrl(file.part.fileId);
        if (cachedUrl) {
          urlMap.set(index, cachedUrl);
          continue;
        }

        const existing = pendingByFileId.get(file.part.fileId);
        if (existing) {
          existing.indexes.push(index);
        } else {
          pendingByFileId.set(file.part.fileId, {
            fileId: file.part.fileId as Id<"files">,
            indexes: [index],
          });
        }
      }

      const pendingFiles = Array.from(pendingByFileId.values());
      for (
        let start = 0;
        start < pendingFiles.length;
        start += FILE_URL_BATCH_SIZE
      ) {
        const chunk = pendingFiles.slice(start, start + FILE_URL_BATCH_SIZE);

        try {
          const batchUrls = await getFileUrlsBatchAction({
            fileIds: chunk.map(({ fileId }) => fileId),
          });

          for (const { fileId, indexes } of chunk) {
            const url = batchUrls[fileId];
            if (!url) {
              continue;
            }

            for (const index of indexes) {
              urlMap.set(index, url);
            }
            fileUrlCache?.setCachedUrl(fileId, url);
          }
        } catch (error) {
          console.error("Failed to fetch file URL batch:", error);
        }
      }

      return urlMap;
    },
    [fileUrlCache, getFileUrlsBatchAction],
  );

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
      const urlMap = await resolveFileUrls(
        files.map((file, index) => ({ file, index })),
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
  }, [open, files, resolveFileUrls]);

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
      let downloadUrls = new Map(fileUrls);
      const missingUrlFiles = filesToDownload.filter(({ file, index }) => {
        return !downloadUrls.get(index) && !file.part.url;
      });

      if (missingUrlFiles.length > 0) {
        const resolvedUrls = await resolveFileUrls(missingUrlFiles);
        downloadUrls = new Map(downloadUrls);
        for (const [index, url] of resolvedUrls.entries()) {
          downloadUrls.set(index, url);
        }
        setFileUrls((current) => {
          const next = new Map(current);
          for (const [index, url] of resolvedUrls.entries()) {
            next.set(index, url);
          }
          return next;
        });
      }

      // Use already fetched URLs or fetch missing ones
      await Promise.all(
        filesToDownload.map(async ({ file, index }) => {
          try {
            let url: string | null | undefined =
              downloadUrls.get(index) || file.part.url;

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
      let fileName = "task-files";
      if (chatTitle) {
        // Sanitize the title for use in filename
        fileName = formatTaskTitle(chatTitle)
          .replace(/[^a-zA-Z0-9-_ ]/g, "") // Remove invalid characters
          .replace(/\s+/g, "-") // Replace spaces with hyphens
          .substring(0, 50); // Limit length
      }
      if (!fileName || fileName === "") {
        const timestamp = new Date().toISOString().split("T")[0];
        fileName = `task-files-${timestamp}`;
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
        <DialogTitle className="sr-only">All files in this task</DialogTitle>
        <DialogDescription className="sr-only">
          Download files attached to this task.
        </DialogDescription>
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
              All files in this task
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
