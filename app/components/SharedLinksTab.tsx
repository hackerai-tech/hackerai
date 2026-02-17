"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { useQuery, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SharedChat } from "@/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { toast } from "sonner";
import { Copy, Trash2, ExternalLink, Share2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

const SharedLinksTab = () => {
  const sharedChats = useQuery(api.sharedChats.getUserSharedChats);
  const unshareChat = useMutation(api.sharedChats.unshareChat);
  const unshareAllChats = useMutation(api.sharedChats.unshareAllChats);

  const [showUnshareAll, setShowUnshareAll] = useState(false);
  const [isUnsharingAll, setIsUnsharingAll] = useState(false);
  const [unshareTarget, setUnshareTarget] = useState<string | null>(null);
  const [isUnsharing, setIsUnsharing] = useState(false);

  const handleCopyLink = async (shareId: string, chatTitle: string) => {
    const shareUrl = `${window.location.origin}/share/${shareId}`;
    try {
      await navigator.clipboard.writeText(shareUrl);
      toast.success(`Link copied for "${chatTitle}"`);
    } catch (error) {
      console.error("Failed to copy share link:", error);
      toast.error("Unable to copy link. Please copy manually.");
    }
  };

  const handleOpenShare = (shareId: string) => {
    const shareUrl = `${window.location.origin}/share/${shareId}`;
    window.open(shareUrl, "_blank");
  };

  const handleUnshare = async (chatId: string, chatTitle: string) => {
    if (isUnsharing) return;
    setIsUnsharing(true);
    try {
      await unshareChat({ chatId });
      toast.success(`"${chatTitle}" is no longer shared`);
    } catch (error) {
      console.error("Failed to unshare chat:", error);
      toast.error("Failed to unshare chat");
    } finally {
      setUnshareTarget(null);
      setIsUnsharing(false);
    }
  };

  const handleUnshareAll = async () => {
    if (isUnsharingAll) return;
    setIsUnsharingAll(true);
    try {
      await unshareAllChats();
      toast.success("All chats unshared successfully");
    } catch (error) {
      console.error("Failed to unshare all chats:", error);
      toast.error("Failed to unshare all chats");
    } finally {
      setShowUnshareAll(false);
      setIsUnsharingAll(false);
    }
  };

  const formatShareDate = (timestamp: number) => {
    return formatDistanceToNow(new Date(timestamp), { addSuffix: true });
  };

  // Loading state
  if (sharedChats === undefined) {
    return (
      <div className="space-y-6 min-h-0">
        <div className="flex items-center justify-center py-8">
          <div className="text-sm text-muted-foreground">
            Loading shared links...
          </div>
        </div>
      </div>
    );
  }

  // Empty state
  if (sharedChats.length === 0) {
    return (
      <div className="space-y-6 min-h-0">
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Share2 className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No shared chats</h3>
          <p className="text-sm text-muted-foreground max-w-sm">
            When you share a chat, it will appear here. You can manage all your
            shared links from this page.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 min-h-0">
      {/* Header with Unshare All button */}
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-medium">
            Shared Chats ({sharedChats.length})
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Manage your publicly shared conversations
          </p>
        </div>
        {sharedChats.length > 0 && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowUnshareAll(true)}
            aria-label="Unshare all chats"
          >
            Unshare All
          </Button>
        )}
      </div>

      {/* Shared Chats List */}
      <div className="space-y-3">
        {sharedChats.map((chat: SharedChat) => (
          <div
            key={chat.id}
            className="flex items-center justify-between p-4 rounded-lg border bg-card hover:bg-accent/50 transition-colors"
          >
            <div className="flex-1 min-w-0 mr-4">
              <div className="font-medium truncate">{chat.title}</div>
              <div className="text-xs text-muted-foreground mt-1">
                Shared {formatShareDate(chat.share_date!)}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleCopyLink(chat.share_id!, chat.title)}
                aria-label="Copy share link"
                title="Copy link"
              >
                <Copy className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleOpenShare(chat.share_id!)}
                aria-label="Open shared chat"
                title="Open in new tab"
              >
                <ExternalLink className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setUnshareTarget(chat.id)}
                aria-label="Unshare chat"
                title="Unshare"
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      {/* Unshare Single Chat Confirmation Dialog */}
      <AlertDialog
        open={unshareTarget !== null}
        onOpenChange={(open) => !open && setUnshareTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unshare this chat?</AlertDialogTitle>
            <AlertDialogDescription>
              The public link will stop working and no one will be able to
              access this shared chat anymore. You can always share it again
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnsharing}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (unshareTarget) {
                  const chat = sharedChats.find(
                    (c: SharedChat) => c.id === unshareTarget,
                  );
                  if (chat) {
                    handleUnshare(unshareTarget, chat.title);
                  }
                }
              }}
              disabled={isUnsharing}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isUnsharing ? "Unsharing..." : "Unshare"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unshare All Confirmation Dialog */}
      <AlertDialog open={showUnshareAll} onOpenChange={setShowUnshareAll}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unshare all chats?</AlertDialogTitle>
            <AlertDialogDescription>
              This will remove public access to all {sharedChats.length} of your
              shared chats. All share links will stop working. You can always
              share your chats again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isUnsharingAll}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleUnshareAll}
              disabled={isUnsharingAll}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isUnsharingAll ? "Unsharing..." : "Unshare All"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export { SharedLinksTab };
