"use client";

import React, { useState, useEffect } from "react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Copy, Check, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";

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
  const [shareDate, setShareDate] = useState<number | undefined>(existingShareDate);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);
  const [isUnsharing, setIsUnsharing] = useState(false);
  const [error, setError] = useState<string>("");
  const [copied, setCopied] = useState(false);

  const shareChat = useMutation(api.chats.shareChat);
  const updateShareDate = useMutation(api.chats.updateShareDate);
  const unshareChat = useMutation(api.chats.unshareChat);

  useEffect(() => {
    if (open) {
      // Reset all states when dialog opens
      setError("");
      setCopied(false);
      setIsGenerating(false);
      setIsUpdating(false);
      setIsUnsharing(false);

      // If already shared, set the URL immediately
      if (existingShareId) {
        const url = `${window.location.origin}/share/${existingShareId}`;
        setShareUrl(url);
        setShareDate(existingShareDate);
      } else {
        // Reset URL and date if not shared
        setShareUrl("");
        setShareDate(undefined);
      }
      // Don't auto-share - let user click a button to create share
    }
  }, [open, existingShareId, existingShareDate]);

  const generateShareLink = async () => {
    setIsGenerating(true);
    setError("");

    try {
      const result = await shareChat({ chatId });
      const url = `${window.location.origin}/share/${result.shareId}`;
      setShareUrl(url);
      setShareDate(result.shareDate);
      toast.success("Share link created!");
    } catch (err) {
      setError("Failed to generate share link. Please try again.");
      console.error("Share error:", err);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleUpdateShare = async () => {
    setIsUpdating(true);
    setError("");

    try {
      const result = await updateShareDate({ chatId });
      setShareDate(result.shareDate);
      toast.success("Share updated! New messages are now included.");
    } catch (err) {
      setError("Failed to update share. Please try again.");
      console.error("Update share error:", err);
      toast.error("Failed to update share");
    } finally {
      setIsUpdating(false);
    }
  };

  const handleUnshare = async () => {
    setIsUnsharing(true);
    setError("");

    try {
      await unshareChat({ chatId });
      toast.success("Chat is no longer shared");
      handleClose();
    } catch (err) {
      setError("Failed to unshare. Please try again.");
      console.error("Unshare error:", err);
      toast.error("Failed to unshare chat");
      setIsUnsharing(false);
    }
  };

  const formatShareDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 60) {
      return `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
    } else if (diffHours < 24) {
      return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
    } else if (diffDays < 7) {
      return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
    } else {
      return date.toLocaleDateString();
    }
  };

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
      x: `https://twitter.com/intent/tweet?url=${encodedUrl}&text=${encodedTitle}`,
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
    setIsUpdating(false);
    setIsUnsharing(false);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogTitle>Share chat</DialogTitle>
        <DialogDescription>
          Share this conversation via a public link. Files and images will not
          be included.
        </DialogDescription>

        <div className="space-y-4">
          {/* Chat Title Preview */}
          <div className="text-sm text-muted-foreground">
            <strong>Sharing:</strong> {chatTitle}
          </div>

          {/* Error State */}
          {error && (
            <div className="space-y-2">
              <p className="text-sm text-destructive">{error}</p>
              <Button onClick={generateShareLink} variant="outline" size="sm">
                Try again
              </Button>
            </div>
          )}

          {/* Not Yet Shared - Show Create Button */}
          {!shareUrl && !isGenerating && !existingShareId && (
            <div className="space-y-4">
              <div className="bg-muted/50 rounded-md p-4 text-sm text-muted-foreground">
                <p>
                  Create a public link to share this conversation. The share will
                  be a snapshot of messages up to now. Files and images won't be
                  included for privacy.
                </p>
              </div>
              <Button onClick={generateShareLink} className="w-full">
                Create Share Link
              </Button>
            </div>
          )}

          {/* Loading State */}
          {isGenerating && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" />
              <span>Generating share link...</span>
            </div>
          )}

          {/* Already Shared - Show Share URL and Actions */}
          {shareUrl && !isGenerating && (
            <>
              {/* Share Date Indicator */}
              {shareDate && (
                <div className="bg-muted rounded-md p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="text-sm">
                      <span className="text-muted-foreground">Shared:</span>{" "}
                      <span className="font-medium">{formatShareDate(shareDate)}</span>
                    </div>
                    <Button
                      onClick={handleUpdateShare}
                      variant="ghost"
                      size="sm"
                      disabled={isUpdating}
                      className="h-7"
                    >
                      {isUpdating ? (
                        <>
                          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                          Updating...
                        </>
                      ) : (
                        <>
                          <RefreshCw className="h-3 w-3 mr-1" />
                          Update Share
                        </>
                      )}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {existingShareId
                      ? "This share includes messages up to the share date. Click Update to include new messages."
                      : "Your share is a snapshot. New messages won't be visible until you update."}
                  </p>
                </div>
              )}

              <div className="flex gap-2">
                <Input value={shareUrl} readOnly className="flex-1" />
                <Button
                  onClick={handleCopyLink}
                  variant="outline"
                  size="icon"
                  aria-label="Copy link"
                >
                  {copied ? (
                    <Check className="h-4 w-4" />
                  ) : (
                    <Copy className="h-4 w-4" />
                  )}
                </Button>
              </div>

              {/* Social Media Buttons */}
              <div className="flex gap-2">
                <Button
                  onClick={() => handleSocialShare("x")}
                  variant="outline"
                  className="flex-1"
                  aria-label="Share on X"
                >
                  <svg
                    className="h-4 w-4 mr-2"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                  </svg>
                  X
                </Button>
                <Button
                  onClick={() => handleSocialShare("linkedin")}
                  variant="outline"
                  className="flex-1"
                  aria-label="Share on LinkedIn"
                >
                  <svg
                    className="h-4 w-4 mr-2"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                  </svg>
                  LinkedIn
                </Button>
                <Button
                  onClick={() => handleSocialShare("reddit")}
                  variant="outline"
                  className="flex-1"
                  aria-label="Share on Reddit"
                >
                  <svg
                    className="h-4 w-4 mr-2"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.8 3.747c1.824.07 3.48.632 4.674 1.488.308-.309.73-.491 1.207-.491.968 0 1.754.786 1.754 1.754 0 .716-.435 1.333-1.01 1.614a3.111 3.111 0 0 1 .042.520c0 2.694-3.13 4.87-7.004 4.87-3.874 0-7.004-2.176-7.004-4.87 0-.183.015-.366.043-.534A1.748 1.748 0 0 1 4.028 12c0-.968.786-1.754 1.754-1.754.463 0 .898.196 1.207.49 1.207-.883 2.878-1.43 4.744-1.487l.885-4.182a.342.342 0 0 1 .14-.197.35.35 0 0 1 .238-.042l2.906.617a1.214 1.214 0 0 1 1.108-.701zM9.25 12C8.561 12 8 12.562 8 13.25c0 .687.561 1.248 1.25 1.248.687 0 1.248-.561 1.248-1.249 0-.688-.561-1.249-1.249-1.249zm5.5 0c-.687 0-1.248.561-1.248 1.25 0 .687.561 1.248 1.249 1.248.688 0 1.249-.561 1.249-1.249 0-.687-.562-1.249-1.25-1.249zm-5.466 3.99a.327.327 0 0 0-.231.094.33.33 0 0 0 0 .463c.842.842 2.484.913 2.961.913.477 0 2.105-.056 2.961-.913a.361.361 0 0 0 .029-.463.33.33 0 0 0-.464 0c-.547.533-1.684.73-2.512.73-.828 0-1.979-.196-2.512-.73a.326.326 0 0 0-.232-.095z" />
                  </svg>
                  Reddit
                </Button>
              </div>

              {/* Unshare Button */}
              <div className="pt-2 border-t">
                <Button
                  onClick={handleUnshare}
                  variant="ghost"
                  className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                  disabled={isUnsharing}
                  aria-label="Unshare chat"
                >
                  {isUnsharing ? (
                    <>
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                      Unsharing...
                    </>
                  ) : (
                    "Unshare"
                  )}
                </Button>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
};
