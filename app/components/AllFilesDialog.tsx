"use client";

import React, {
  useState,
  useEffect,
  useLayoutEffect,
  useCallback,
  useRef,
} from "react";
import { X, Download, Circle, CircleCheck, File } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAction, useConvexAuth } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { useFileUrlCacheContext } from "@/app/contexts/FileUrlCacheContext";
import type { FilePart } from "@/types/file";
import JSZip from "jszip";
import { toast } from "sonner";
import { isTauriEnvironment, openDownloadsFolder } from "@/app/hooks/useTauri";
import { formatTaskTitle } from "@/app/utils/task-ui-copy";
import { startBlobDownload } from "@/lib/utils/file-download";

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
  onDownload: () => void;
  downloading: boolean;
}

const FileItem = ({
  file,
  isSelected,
  selectionMode,
  onToggle,
  fileUrl,
  onDownload,
  downloading,
}: FileItemProps) => {
  const fileName = file.part.name || file.part.filename || "Unknown file";

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2.5 hover:bg-secondary transition-colors rounded-lg ${
        selectionMode ? "cursor-pointer" : ""
      }`}
      onClick={selectionMode && !downloading ? onToggle : undefined}
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
          disabled={downloading}
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
          onClick={onDownload}
          disabled={downloading}
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
  const { isAuthenticated, isLoading, isRefreshing } = useConvexAuth();
  const authReady = isAuthenticated && !isLoading && !isRefreshing;
  const authScopeRef = useRef(new AbortController());
  useLayoutEffect(() => {
    const scope = new AbortController();
    authScopeRef.current = scope;
    return () => scope.abort();
  }, [authReady, open]);
  const downloadInProgress = useRef(false);
  const [downloading, setDownloading] = useState(false);
  const getFileUrlsBatchAction = useAction(
    api.s3Actions.getFileUrlsBatchAction,
  );
  const fileUrlCache = useFileUrlCacheContext();
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [fileUrls, setFileUrls] = useState<Map<number, string>>(new Map());
  const [isLoadingUrls, setIsLoadingUrls] = useState(false);
  const [previousAuthReady, setPreviousAuthReady] = useState(authReady);
  // Reset before committing children so a restored session cannot briefly
  // display URLs retained from an earlier authentication scope.
  if (previousAuthReady !== authReady) {
    setPreviousAuthReady(authReady);
    setFileUrls(new Map());
  }

  const resolveFileUrls = useCallback(
    async (
      items: Array<{
        file: DialogFile;
        index: number;
      }>,
    ): Promise<Map<number, string>> => {
      const urlMap = new Map<number, string>();
      if (!authReady) return urlMap;
      const scope = authScopeRef.current;
      const pendingByFileId = new Map<
        string,
        { fileId: Id<"files">; indexes: number[] }
      >();

      for (const { file, index } of items) {
        if (!file.part.fileId) {
          if (file.part.url) urlMap.set(index, file.part.url);
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
        if (scope.signal.aborted) return new Map();
        const chunk = pendingFiles.slice(start, start + FILE_URL_BATCH_SIZE);

        try {
          const batchUrls = await getFileUrlsBatchAction({
            fileIds: chunk.map(({ fileId }) => fileId),
          });
          if (scope.signal.aborted) return new Map();

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
          if (!scope.signal.aborted)
            console.error("Failed to fetch file URL batch:", error);
        }
      }

      return urlMap;
    },
    [fileUrlCache, getFileUrlsBatchAction, authReady],
  );

  const handleOpenChange = (newOpen: boolean) => {
    if (!newOpen) {
      authScopeRef.current.abort();
      setFileUrls(new Map());
      setIsLoadingUrls(false);
      setSelectionMode(false);
      setSelectedFiles(new Set());
    }
    onOpenChange(newOpen);
  };

  // Batch fetch all URLs when dialog opens
  useEffect(() => {
    if (!authReady) return;
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
  }, [open, files, resolveFileUrls, authReady]);

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

  const handleDownload = async (singleIndex?: number) => {
    if (!authReady || !open || downloadInProgress.current) return;
    const items = files
      .map((file, index) => ({ file, index }))
      .filter(({ index }) =>
        singleIndex === undefined
          ? selectedFiles.has(index.toString())
          : index === singleIndex,
      );
    if (items.length === 0) return;
    const scope = authScopeRef.current;
    downloadInProgress.current = true;
    setDownloading(true);
    try {
      // Consult the expiring cache again at click time, not the dialog's snapshot.
      const urls = await resolveFileUrls(items);
      if (scope.signal.aborted) return;
      const results = await Promise.allSettled(
        items.map(async ({ index }) => {
          const url = urls.get(index);
          if (!url) throw new Error("File URL unavailable");
          const response = await fetch(url, { signal: scope.signal });
          if (!response.ok) throw new Error("File download request failed");
          return response.blob();
        }),
      );
      if (scope.signal.aborted) return;
      const failed = items.filter(
        (_, index) => results[index].status === "rejected",
      );
      if (failed.length > 0) {
        toast.error(
          singleIndex === undefined
            ? "Could not download all selected files"
            : "Failed to download file",
          {
            description: `${failed.length} of ${items.length} unavailable: ${failed
              .slice(0, 3)
              .map(
                ({ file }) =>
                  file.part.name || file.part.filename || "Unknown file",
              )
              .join(
                ", ",
              )}${failed.length > 3 ? "…" : ""}. Try again or deselect these files.`,
          },
        );
        return;
      }
      const blobs = results.map(
        (result) => (result as PromiseFulfilledResult<Blob>).value,
      );
      let blob: Blob;
      let filename: string;
      if (singleIndex !== undefined) {
        blob = blobs[0];
        filename =
          items[0].file.part.name ||
          items[0].file.part.filename ||
          "Unknown file";
      } else {
        const zip = new JSZip();
        const usedNames = new Set<string>();
        items.forEach(({ file }, index) => {
          // A ZIP maps names to entries: preserve colliding files instead of overwriting.
          const original = (
            file.part.name ||
            file.part.filename ||
            `file-${file.partIndex}`
          ).replace(/[\\/]/g, "_");
          const name =
            original === "." || original === ".." ? `file-${index}` : original;
          const dot = name.lastIndexOf(".");
          const stem = dot > 0 ? name.slice(0, dot) : name;
          const extension = dot > 0 ? name.slice(dot) : "";
          let unique = name;
          let suffix = 2;
          while (usedNames.has(unique.toLowerCase()))
            unique = `${stem} (${suffix++})${extension}`;
          usedNames.add(unique.toLowerCase());
          zip.file(unique, blobs[index]);
        });
        blob = await zip.generateAsync({ type: "blob" });
        const title = chatTitle
          ? formatTaskTitle(chatTitle)
              .replace(/[^a-zA-Z0-9-_ ]/g, "")
              .replace(/\s+/g, "-")
              .substring(0, 50)
          : "task-files";
        filename = `${title || `task-files-${new Date().toISOString().split("T")[0]}`}.zip`;
      }
      if (scope.signal.aborted) return;
      startBlobDownload(blob, filename);
      toast.success(
        `Download started: ${filename}`,
        isTauriEnvironment()
          ? {
              action: {
                label: "Open Downloads",
                onClick: () => openDownloadsFolder(),
              },
            }
          : undefined,
      );
      if (singleIndex === undefined) handleCancelSelection();
    } catch {
      if (!scope.signal.aborted)
        toast.error("Failed to download files. Try again.");
    } finally {
      downloadInProgress.current = false;
      setDownloading(false);
    }
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
              disabled={downloading}
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
              disabled={downloading}
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
            ) : authReady && isLoadingUrls ? (
              <div className="text-center text-muted-foreground py-8">
                Loading files...
              </div>
            ) : (
              files.map((file, index) => {
                const fileId = index.toString();
                const isSelected = selectedFiles.has(fileId);
                const fileUrl = authReady
                  ? fileUrls.get(index) ||
                    (!file.part.fileId ? file.part.url : null) ||
                    null
                  : null;

                return (
                  <FileItem
                    key={`${file.messageId}-${file.partIndex}`}
                    file={file}
                    isSelected={isSelected}
                    selectionMode={selectionMode}
                    onToggle={() => handleToggleFile(fileId)}
                    fileUrl={fileUrl}
                    downloading={downloading}
                    onDownload={() => void handleDownload(index)}
                  />
                );
              })
            )}
          </div>
        </div>

        {selectionMode && (
          <footer className="px-5 py-4 border-t border-border flex justify-end">
            <Button
              onClick={() => void handleDownload()}
              variant="outline"
              className="h-9 px-3 rounded-full"
              disabled={!authReady || downloading || selectedFiles.size === 0}
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
