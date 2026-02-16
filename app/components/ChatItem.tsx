"use client";

import React, { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { ConvexError } from "convex/values";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Ellipsis,
  Trash2,
  Edit2,
  Split,
  Share,
  Pin,
  PinOff,
} from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { removeDraft } from "@/lib/utils/client-storage";
import { ShareDialog } from "./ShareDialog";
import { usePinChat, useUnpinChat } from "../hooks/useChats";

interface ChatItemProps {
  id: string;
  title: string;
  isBranched?: boolean;
  branchedFromTitle?: string;
  shareId?: string;
  shareDate?: number;
  isPinned?: boolean;
}

const ChatItem: React.FC<ChatItemProps> = ({
  id,
  title,
  isBranched = false,
  branchedFromTitle,
  shareId,
  shareDate,
  isPinned = false,
}) => {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [showShareDialog, setShowShareDialog] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    closeSidebar,
    setChatSidebarOpen,
    initializeNewChat,
    initializeChat,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const deleteChat = useMutation(api.chats.deleteChat);
  const renameChat = useMutation(api.chats.renameChat);
  const pinChat = usePinChat();
  const unpinChat = useUnpinChat();

  // Check if this chat is currently active based on URL
  const isCurrentlyActive = window.location.pathname === `/c/${id}`;

  const handleClick = () => {
    // Don't navigate if dialog is open or dropdown is open
    if (showRenameDialog || isDropdownOpen) {
      return;
    }

    closeSidebar();

    if (isMobile) {
      setChatSidebarOpen(false);
    }

    // Clear input and transient state only when switching to a different chat
    if (!isCurrentlyActive) {
      initializeChat(id);
    }

    // Navigate to the chat route
    router.push(`/c/${id}`);
  };

  const [isDeleting, setIsDeleting] = useState(false);

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    if (isDeleting) return;
    setIsDeleting(true);

    try {
      await deleteChat({ chatId: id });

      // Remove draft from localStorage immediately after successful deletion
      removeDraft(id);

      // If we're deleting the currently active chat, navigate to home
      if (isCurrentlyActive) {
        initializeNewChat();
        router.push("/");
      }
    } catch (error: any) {
      // Extract error message
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to delete chat"
          : error instanceof Error
            ? error.message
            : String(error?.message || error);

      // Treat not found as success, and show other errors
      if (errorMessage.includes("Chat not found")) {
        // Even if chat not found in DB, still clean up draft
        removeDraft(id);
        if (isCurrentlyActive) {
          initializeNewChat();
          router.push("/");
        }
      } else {
        console.error("Failed to delete chat:", error);
        toast.error(errorMessage);
      }
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRename = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Close dropdown first, then open dialog with a small delay to avoid focus conflicts
    setIsDropdownOpen(false);
    setEditTitle(title); // Set the current title when opening dialog

    // Small delay to ensure dropdown is fully closed before opening dialog
    setTimeout(() => {
      setShowRenameDialog(true);
    }, 50);
  };

  const handleShare = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    // Close dropdown first, then open share dialog
    setIsDropdownOpen(false);

    // Small delay to ensure dropdown is fully closed before opening dialog
    setTimeout(() => {
      setShowShareDialog(true);
    }, 50);
  };

  const handlePin = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropdownOpen(false);
    try {
      await pinChat({ chatId: id });
    } catch (error) {
      if (error instanceof ConvexError) {
        const data = error.data as { code?: string; message?: string };
        if (data.code === "MAX_PINNED_REACHED") {
          toast.error(data.message ?? "You can pin at most 3 chats");
          return;
        }
      }
      console.error("Failed to pin chat:", error);
      toast.error("Failed to pin chat");
    }
  };

  const handleUnpin = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDropdownOpen(false);
    try {
      await unpinChat({ chatId: id });
    } catch (error) {
      console.error("Failed to unpin chat:", error);
      toast.error("Failed to unpin chat");
    }
  };

  const handleSaveRename = async () => {
    const trimmedTitle = editTitle.trim();

    // Don't save if title is empty or unchanged
    if (!trimmedTitle || trimmedTitle === title) {
      setShowRenameDialog(false);
      setEditTitle(title); // Reset to original title
      return;
    }

    try {
      setIsRenaming(true);
      await renameChat({ chatId: id, newTitle: trimmedTitle });
      setShowRenameDialog(false);
    } catch (error) {
      console.error("Failed to rename chat:", error);
      const errorMessage =
        error instanceof ConvexError
          ? (error.data as { message?: string })?.message ||
            error.message ||
            "Failed to rename chat"
          : error instanceof Error
            ? error.message
            : "Failed to rename chat";
      toast.error(errorMessage);
      setEditTitle(title); // Reset to original title on error
    } finally {
      setIsRenaming(false);
    }
  };

  const handleCancelRename = () => {
    setShowRenameDialog(false);
    setEditTitle(title); // Reset to original title
  };

  const handleInputKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSaveRename();
    } else if (e.key === "Escape") {
      e.preventDefault();
      handleCancelRename();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Don't handle keyboard events if dialog or dropdown is open
    if (showRenameDialog || isDropdownOpen) return;

    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handleClick();
    }
  };

  return (
    <div
      className={`group relative flex w-full cursor-pointer items-center rounded-lg p-2 hover:bg-sidebar-accent/50 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ${
        isCurrentlyActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : ""
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      title={title}
      role="button"
      tabIndex={0}
      aria-label={`Open chat: ${title}`}
      data-testid={`chat-item-${id}`}
    >
      <div
        className={`mr-2 min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium ${
          isHovered || isCurrentlyActive || isDropdownOpen || isMobile
            ? "[-webkit-mask-image:var(--sidebar-mask-active)] [mask-image:var(--sidebar-mask-active)]"
            : "[-webkit-mask-image:var(--sidebar-mask)] [mask-image:var(--sidebar-mask)]"
        }`}
        dir="auto"
      >
        <span className="flex items-center gap-1.5">
          {isPinned && (
            <Pin
              className="size-3 flex-shrink-0 text-muted-foreground"
              data-testid="chat-item-pin-icon"
            />
          )}
          {isBranched && branchedFromTitle && (
            <TooltipProvider delayDuration={300}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Split className="size-3 flex-shrink-0 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="right">
                  <p className="text-xs">Branched from: {branchedFromTitle}</p>
                </TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
          {title}
        </span>
      </div>

      <div
        className={`absolute right-2 opacity-0 transition-opacity ${
          isHovered || isCurrentlyActive || isDropdownOpen || isMobile
            ? "opacity-100"
            : ""
        }`}
      >
        <DropdownMenu open={isDropdownOpen} onOpenChange={setIsDropdownOpen}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 hover:bg-sidebar-accent"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
              }}
              aria-label="Open conversation options"
            >
              <Ellipsis className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            sideOffset={5}
            className="z-50 py-2"
            onClick={(e) => e.stopPropagation()}
          >
            <DropdownMenuItem onClick={handleRename}>
              <Edit2 className="mr-2 h-4 w-4" />
              Rename
            </DropdownMenuItem>
            {isPinned ? (
              <DropdownMenuItem onClick={handleUnpin}>
                <PinOff className="mr-2 h-4 w-4" />
                Unpin
              </DropdownMenuItem>
            ) : (
              <DropdownMenuItem onClick={handlePin}>
                <Pin className="mr-2 h-4 w-4" />
                Pin
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={handleShare}>
              <Share className="mr-2 h-4 w-4" />
              Share
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={handleDelete}
              className="text-destructive focus:text-destructive"
            >
              <Trash2 className="mr-2 h-4 w-4" />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Rename Dialog */}
      <Dialog open={showRenameDialog} onOpenChange={setShowRenameDialog}>
        <DialogContent className="sm:max-w-[425px]">
          <DialogHeader>
            <DialogTitle>Rename Chat</DialogTitle>
            <DialogDescription>
              Enter a new name for this chat conversation.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <Input
              ref={inputRef}
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              onKeyDown={handleInputKeyDown}
              disabled={isRenaming}
              placeholder="Chat name"
              maxLength={100}
              className="w-full"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={handleCancelRename}
              disabled={isRenaming}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleSaveRename}
              disabled={isRenaming || !editTitle.trim()}
            >
              {isRenaming ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Share Dialog */}
      <ShareDialog
        open={showShareDialog}
        onOpenChange={setShowShareDialog}
        chatId={id}
        chatTitle={title}
        existingShareId={shareId}
        existingShareDate={shareDate}
      />
    </div>
  );
};

export default ChatItem;
