"use client";

import React, { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Ellipsis, Trash2, Edit2 } from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";

interface ChatItemProps {
  id: string;
  title: string;
  isActive?: boolean;
}

const ChatItem: React.FC<ChatItemProps> = ({ id, title, isActive = false }) => {
  const router = useRouter();
  const [isHovered, setIsHovered] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [isRenaming, setIsRenaming] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  
  const {
    closeSidebar,
    setChatSidebarOpen,
    currentChatId,
    initializeChat,
    initializeNewChat,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const deleteChat = useMutation(api.chats.deleteChat);
  const renameChat = useMutation(api.chats.renameChat);

  // Use global currentChatId to determine if this item is active
  const isCurrentlyActive = currentChatId === id;

  const handleClick = () => {
    // Don't navigate if dialog is open or dropdown is open
    if (showRenameDialog || isDropdownOpen) {
      return;
    }
    
    closeSidebar();

    if (isMobile) {
      setChatSidebarOpen(false);
    }

    // Use the new initializeChat function for consistent state management
    initializeChat(id, true);
    router.push(`/c/${id}`);
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    try {
      await deleteChat({ chatId: id });

      // If we're deleting the currently active chat, navigate to home
      if (isCurrentlyActive) {
        initializeNewChat();
        router.push("/");
      }
    } catch (error) {
      console.error("Failed to delete chat:", error);
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
    >
      <div
        className={`mr-2 flex-1 overflow-hidden text-clip whitespace-nowrap text-sm font-medium ${
          isHovered || isCurrentlyActive || isDropdownOpen || isMobile
            ? "[-webkit-mask-image:var(--sidebar-mask-active)] [mask-image:var(--sidebar-mask-active)]"
            : "[-webkit-mask-image:var(--sidebar-mask)] [mask-image:var(--sidebar-mask)]"
        }`}
        dir="auto"
      >
        {title}
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
    </div>
  );
};

export default ChatItem;
