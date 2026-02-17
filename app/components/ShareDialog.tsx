"use client";

import React, { useState, useEffect } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { PreviewMessage } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, Loader2, X as XIcon } from "lucide-react";
import { toast } from "sonner";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { MemoizedMarkdown } from "@/app/components/MemoizedMarkdown";

interface ShareDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  chatId: string;
  chatTitle: string;
  existingShareId?: string;
  existingShareDate?: number;
}

export const ShareDialog = ({
  open,
  onOpenChange,
  chatId,
  chatTitle,
  existingShareId,
  existingShareDate,
}: ShareDialogProps) => {
  const [shareUrl, setShareUrl] = useState<string>("");
  const [shareDate, setShareDate] = useState<number | undefined>(
    existingShareDate,
  );
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const shareChat = useMutation(api.sharedChats.shareChat);
  const updateShareDate = useMutation(api.sharedChats.updateShareDate);

  // Fetch preview messages for the dialog
  const previewMessages = useQuery(
    api.messages.getPreviewMessages,
    open ? { chatId } : "skip",
  );

  useEffect(() => {
    if (open) {
      // Reset all states when dialog opens
      setError("");
      setCopied(false);
      setIsGenerating(false);

      // Auto-generate or update share when dialog opens
      const handleAutoShare = async () => {
        setIsGenerating(true);
        try {
          if (existingShareId) {
            // Update existing share to include new messages
            const result = await updateShareDate({ chatId });
            const url = `${window.location.origin}/share/${existingShareId}`;
            setShareUrl(url);
            setShareDate(result.shareDate);
          } else {
            // Create new share
            const result = await shareChat({ chatId });
            const url = `${window.location.origin}/share/${result.shareId}`;
            setShareUrl(url);
            setShareDate(result.shareDate);
          }
        } catch (err) {
          setError("Failed to generate share link. Please try again.");
          console.error("Share error:", err);
        } finally {
          setIsGenerating(false);
        }
      };

      handleAutoShare();
    }
  }, [open, existingShareId, chatId, shareChat, updateShareDate]);

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      toast.success("Link copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      toast.error("Failed to copy link");
      console.error("Copy error:", err);
    }
  };

  const handleSocialShare = (platform: "x" | "linkedin" | "reddit") => {
    const encodedUrl = encodeURIComponent(shareUrl);
    const encodedTitle = encodeURIComponent(chatTitle);

    const urls = {
      x: `https://x.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
      linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${encodedUrl}`,
      reddit: `https://reddit.com/submit?url=${encodedUrl}&title=${encodedTitle}`,
    };

    window.open(urls[platform], "_blank", "noopener,noreferrer");
  };

  const handleClose = () => {
    setShareUrl("");
    setError("");
    setCopied(false);
    setIsGenerating(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent
        className="sm:max-w-[640px] p-0 gap-0 overflow-hidden"
        showCloseButton={false}
      >
        {/* Header */}
        <div className="px-6 py-4 border-b flex items-center justify-between">
          <DialogTitle className="text-3xl font-semibold">
            {chatTitle}
          </DialogTitle>
          <Button
            variant="ghost"
            size="icon"
            className="h-9 w-9 rounded-lg"
            onClick={handleClose}
            aria-label="Close"
          >
            <XIcon className="h-5 w-5" />
          </Button>
        </div>

        <DialogDescription className="sr-only">
          Share this conversation via a public link
        </DialogDescription>

        {/* Loading State */}
        {isGenerating && (
          <div className="flex items-center justify-center py-20">
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <p className="text-sm text-muted-foreground">
                Generating share link...
              </p>
            </div>
          </div>
        )}

        {/* Error State */}
        {error && (
          <div className="px-6 py-8">
            <div className="space-y-4">
              <p className="text-sm text-destructive text-center">{error}</p>
              <Button
                onClick={async () => {
                  setError("");
                  setIsGenerating(true);
                  try {
                    if (existingShareId) {
                      const result = await updateShareDate({ chatId });
                      setShareUrl(
                        `${window.location.origin}/share/${existingShareId}`,
                      );
                      setShareDate(result.shareDate);
                    } else {
                      const result = await shareChat({ chatId });
                      setShareUrl(
                        `${window.location.origin}/share/${result.shareId}`,
                      );
                      setShareDate(result.shareDate);
                    }
                  } catch (err) {
                    setError(
                      "Failed to generate share link. Please try again.",
                    );
                  } finally {
                    setIsGenerating(false);
                  }
                }}
                variant="outline"
                size="sm"
                className="w-full"
              >
                Try again
              </Button>
            </div>
          </div>
        )}

        {/* Share content */}
        {shareUrl && !isGenerating && !error && (
          <div className="flex flex-col">
            {/* Chat Preview */}
            <div className="px-6 py-4">
              <div className="w-full rounded-xl aspect-[1200/630] overflow-hidden border bg-muted/30 relative">
                <div className="h-full w-full overflow-hidden">
                  {/* Content wrapper - adapts to dialog width */}
                  <div className="h-full w-full p-4">
                    <div className="w-full flex flex-col space-y-4">
                      {previewMessages &&
                        previewMessages.map((message: PreviewMessage) => {
                          const isUser = message.role === "user";
                          return (
                            <div
                              key={message.id}
                              className={`flex flex-col ${isUser ? "items-end" : "items-start"}`}
                            >
                              <div
                                className={`${
                                  isUser
                                    ? "w-full flex flex-col gap-1 items-end"
                                    : "w-full text-foreground"
                                } overflow-hidden`}
                              >
                                <div
                                  className={`${
                                    isUser
                                      ? "max-w-[80%] bg-secondary rounded-[18px] px-4 py-1.5 data-[multiline]:py-3 rounded-se-lg text-primary-foreground border border-border"
                                      : "w-full prose space-y-3 max-w-none dark:prose-invert min-w-0"
                                  } overflow-hidden`}
                                >
                                  {isUser ? (
                                    <div className="whitespace-pre-wrap">
                                      {message.content}
                                    </div>
                                  ) : (
                                    <MemoizedMarkdown
                                      content={message.content || ""}
                                    />
                                  )}
                                </div>
                              </div>
                            </div>
                          );
                        })}
                    </div>
                  </div>
                </div>
                {/* Fade-out gradient at the bottom - starts at 66% height, more opaque */}
                <div className="absolute bottom-0 left-0 right-0 h-[34%] bg-gradient-to-t from-muted/90 via-muted/70 via-30% via-muted/40 via-70% to-transparent pointer-events-none" />

                {/* Floating HackerAI Logo - bottom left corner */}
                <div className="absolute bottom-4 right-4 z-10">
                  <HackerAISVG theme="dark" scale={0.12} />
                </div>
              </div>
            </div>

            {/* Social Share Buttons */}
            <div className="px-6 py-4">
              <div className="flex justify-center gap-8">
                {/* Copy Link */}
                <button
                  onClick={handleCopyLink}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div className="h-16 w-16 rounded-full shadow-lg flex items-center justify-center hover:shadow-xl transition-shadow bg-background">
                    <div className="flex h-8 w-8 items-center justify-center">
                      {copied ? (
                        <Check className="h-5 w-5" />
                      ) : (
                        <Copy className="h-5 w-5" />
                      )}
                    </div>
                  </div>
                  <span className="text-xs text-center max-w-16">
                    {copied ? "Copied!" : "Copy link"}
                  </span>
                </button>

                {/* X (Twitter) */}
                <button
                  onClick={() => handleSocialShare("x")}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div className="h-16 w-16 rounded-full shadow-lg flex items-center justify-center hover:shadow-xl transition-shadow bg-background">
                    <div className="flex h-8 w-8 items-center justify-center">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                      </svg>
                    </div>
                  </div>
                  <span className="text-xs text-center max-w-16">X</span>
                </button>

                {/* LinkedIn */}
                <button
                  onClick={() => handleSocialShare("linkedin")}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div className="h-16 w-16 rounded-full shadow-lg flex items-center justify-center hover:shadow-xl transition-shadow bg-background">
                    <div className="flex h-8 w-8 items-center justify-center">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                      </svg>
                    </div>
                  </div>
                  <span className="text-xs text-center max-w-16">LinkedIn</span>
                </button>

                {/* Reddit */}
                <button
                  onClick={() => handleSocialShare("reddit")}
                  className="flex flex-col items-center gap-2 group"
                >
                  <div className="h-16 w-16 rounded-full shadow-lg flex items-center justify-center hover:shadow-xl transition-shadow bg-background">
                    <div className="flex h-8 w-8 items-center justify-center">
                      <svg
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="currentColor"
                      >
                        <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.520c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
                      </svg>
                    </div>
                  </div>
                  <span className="text-xs text-center max-w-16">Reddit</span>
                </button>
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
};
