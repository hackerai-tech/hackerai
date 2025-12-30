import { useState, useEffect, useRef, useCallback } from "react";
import { Button } from "@/components/ui/button";
import TextareaAutosize from "react-textarea-autosize";
import Image from "next/image";
import { X, File } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import {
  countInputTokens,
  getMaxTokensForSubscription,
} from "@/lib/token-utils";
import { toast } from "sonner";

export interface EditableFile {
  fileId: string;
  name: string;
  mediaType?: string;
  url?: string;
}

interface MessageEditorProps {
  initialContent: string;
  initialFiles?: EditableFile[];
  onSave: (content: string, remainingFileIds: string[]) => void;
  onCancel: () => void;
}

export const MessageEditor = ({
  initialContent,
  initialFiles = [],
  onSave,
  onCancel,
}: MessageEditorProps) => {
  const { subscription } = useGlobalState();
  // Initialize state only once - don't sync with props changes
  // This prevents state from being reset when parent re-renders
  const [content, setContent] = useState(initialContent);
  const [files, setFiles] = useState<EditableFile[]>(initialFiles);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    // Auto-focus and select all text when component mounts
    if (textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.select();
    }
  }, []);

  const handleRemoveFile = useCallback((fileId: string) => {
    setFiles((prev) => prev.filter((f) => f.fileId !== fileId));
  }, []);

  const handleSave = () => {
    const trimmedContent = content.trim();

    // Must have either content or files
    if (!trimmedContent && files.length === 0) return;

    // Check token limit for edited content based on user plan
    const tokenCount = countInputTokens(trimmedContent, []);
    const maxTokens = getMaxTokensForSubscription(subscription);

    if (tokenCount > maxTokens) {
      const planText = subscription !== "free" ? "" : " (Free plan limit)";
      toast.error("Message is too long", {
        description: `Your edited message is too large (${tokenCount.toLocaleString()} tokens). Maximum is ${maxTokens.toLocaleString()} tokens${planText}.`,
      });
      return;
    }

    const remainingFileIds = files.map((f) => f.fileId);
    onSave(trimmedContent, remainingFileIds);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      onCancel();
    } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSave();
    }
  };

  const isImage = (mediaType?: string) => mediaType?.startsWith("image/");
  const hasContent = content.trim() || files.length > 0;

  return (
    <div className="w-full bg-secondary border border-border rounded-lg p-4 space-y-3">
      {/* File previews with remove buttons */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {files.map((file) => (
            <div
              key={file.fileId}
              className="group relative inline-block text-sm"
            >
              <div
                className={`relative overflow-hidden border rounded-2xl ${
                  isImage(file.mediaType) ? "bg-background" : "bg-primary"
                }`}
              >
                {isImage(file.mediaType) && file.url ? (
                  <div className="h-20 w-20 relative">
                    <Image
                      src={file.url}
                      alt={file.name}
                      className="h-full w-full object-cover"
                      fill
                      unoptimized
                    />
                  </div>
                ) : (
                  <div className="p-2 w-64">
                    <div className="flex flex-row items-center gap-2">
                      <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded-lg bg-[#FF5588] flex items-center justify-center">
                        <File className="h-6 w-6 text-white" />
                      </div>
                      <div className="overflow-hidden flex-1">
                        <div className="truncate font-semibold text-sm">
                          {file.name}
                        </div>
                        <div className="text-muted-foreground truncate text-xs">
                          Document
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Remove button */}
              <div className="absolute end-1.5 top-1.5 inline-flex gap-1">
                <Button
                  type="button"
                  onClick={() => handleRemoveFile(file.fileId)}
                  variant="secondary"
                  size="sm"
                  className="transition-colors flex h-6 w-6 items-center justify-center rounded-full border-[rgba(0,0,0,0.1)] bg-black text-white dark:border-[rgba(255,255,255,0.1)] dark:bg-white dark:text-black p-0"
                  aria-label={`Remove ${file.name}`}
                  data-testid="remove-edit-file"
                >
                  <X className="h-3 w-3" />
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <TextareaAutosize
        ref={textareaRef}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={handleKeyDown}
        className="w-full p-3 text-foreground rounded-md resize-none focus:outline-none"
        minRows={2}
        maxRows={10}
        placeholder={
          files.length > 0 ? "Add a message (optional)" : "Enter your message"
        }
      />
      <div className="flex justify-end space-x-2">
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!hasContent}>
          Save
        </Button>
      </div>
    </div>
  );
};
