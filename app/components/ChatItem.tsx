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
import { Ellipsis, Trash2, Edit2, Split } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { removeDraft } from "@/lib/utils/client-storage";
import { ShareDialog } from "./ShareDialog";

interface ChatItemProps {
  id: string;
  title: string;
  isBranched?: boolean;
  branchedFromTitle?: string;
  shareId?: string;
  shareDate?: number;
}

const ChatItem: React.FC<ChatItemProps> = ({
  id,
  title,
  isBranched = false,
  branchedFromTitle,
  shareId,
  shareDate,
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
    chatTitle: globalChatTitle,
    currentChatId,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const deleteChat = useMutation(api.chats.deleteChat);
  const renameChat = useMutation(api.chats.renameChat);

  // Check if this chat is currently active based on URL
  const isCurrentlyActive = window.location.pathname === `/c/${id}`;

  // Use global state title only for the currently active chat (based on URL, not global state)
  // to show real-time updates while avoiding flashing the wrong title during navigation
  const displayTitle =
    isCurrentlyActive && globalChatTitle ? globalChatTitle : title;

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
    setEditTitle(displayTitle); // Set the current title when opening dialog

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

  const handleSaveRename = async () => {
    const trimmedTitle = editTitle.trim();

    // Don't save if title is empty or unchanged
    if (!trimmedTitle || trimmedTitle === displayTitle) {
      setShowRenameDialog(false);
      setEditTitle(displayTitle); // Reset to original title
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
      setEditTitle(displayTitle); // Reset to original title on error
    } finally {
      setIsRenaming(false);
    }
  };

  const handleCancelRename = () => {
    setShowRenameDialog(false);
    setEditTitle(displayTitle); // Reset to original title
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
      title={displayTitle}
      role="button"
      tabIndex={0}
      aria-label={`Open chat: ${displayTitle}`}
    >
      <div
        className={`mr-2 flex-1 overflow-hidden text-clip whitespace-nowrap text-sm font-medium ${
          isHovered || isCurrentlyActive || isDropdownOpen || isMobile
            ? "[-webkit-mask-image:var(--sidebar-mask-active)] [mask-image:var(--sidebar-mask-active)]"
            : "[-webkit-mask-image:var(--sidebar-mask)] [mask-image:var(--sidebar-mask)]"
        }`}
        dir="auto"
      >
        <span className="flex items-center gap-1.5">
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
          {displayTitle}
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
            <DropdownMenuItem onClick={handleShare}>
              <svg
                width="16"
                height="16"
                viewBox="0 0 20 20"
                fill="currentColor"
                xmlns="http://www.w3.org/2000/svg"
                className="mr-2 h-4 w-4"
              >
                <path d="M2.66821 12.6663V12.5003C2.66821 12.1331 2.96598 11.8353 3.33325 11.8353C3.70052 11.8353 3.99829 12.1331 3.99829 12.5003V12.6663C3.99829 13.3772 3.9992 13.8707 4.03052 14.2542C4.0612 14.6298 4.11803 14.8413 4.19849 14.9993L4.2688 15.1263C4.44511 15.4137 4.69813 15.6481 5.00024 15.8021L5.13013 15.8577C5.2739 15.9092 5.46341 15.947 5.74536 15.97C6.12888 16.0014 6.62221 16.0013 7.33325 16.0013H12.6663C13.3771 16.0013 13.8707 16.0014 14.2542 15.97C14.6295 15.9394 14.8413 15.8825 14.9993 15.8021L15.1262 15.7308C15.4136 15.5545 15.6481 15.3014 15.802 14.9993L15.8577 14.8695C15.9091 14.7257 15.9469 14.536 15.97 14.2542C16.0013 13.8707 16.0012 13.3772 16.0012 12.6663V12.5003C16.0012 12.1332 16.2991 11.8355 16.6663 11.8353C17.0335 11.8353 17.3313 12.1331 17.3313 12.5003V12.6663C17.3313 13.3553 17.3319 13.9124 17.2952 14.3626C17.2624 14.7636 17.1974 15.1247 17.053 15.4613L16.9866 15.6038C16.7211 16.1248 16.3172 16.5605 15.8215 16.8646L15.6038 16.9866C15.227 17.1786 14.8206 17.2578 14.3625 17.2952C13.9123 17.332 13.3553 17.3314 12.6663 17.3314H7.33325C6.64416 17.3314 6.0872 17.332 5.63696 17.2952C5.23642 17.2625 4.87552 17.1982 4.53931 17.054L4.39673 16.9866C3.87561 16.7211 3.43911 16.3174 3.13501 15.8216L3.01294 15.6038C2.82097 15.2271 2.74177 14.8206 2.70435 14.3626C2.66758 13.9124 2.66821 13.3553 2.66821 12.6663ZM9.33521 12.5003V4.9388L7.13696 7.13704C6.87732 7.39668 6.45625 7.39657 6.19653 7.13704C5.93684 6.87734 5.93684 6.45631 6.19653 6.19661L9.52954 2.86263L9.6311 2.77962C9.73949 2.70742 9.86809 2.66829 10.0002 2.66829C10.1763 2.66838 10.3454 2.73819 10.47 2.86263L13.804 6.19661C14.0633 6.45628 14.0634 6.87744 13.804 7.13704C13.5443 7.39674 13.1222 7.39674 12.8625 7.13704L10.6653 4.93977V12.5003C10.6651 12.8673 10.3673 13.1652 10.0002 13.1654C9.63308 13.1654 9.33538 12.8674 9.33521 12.5003Z" />
              </svg>
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
        chatTitle={displayTitle}
        existingShareId={shareId}
        existingShareDate={shareDate}
      />
    </div>
  );
};

export default ChatItem;
