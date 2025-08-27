"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Ellipsis, Trash2 } from "lucide-react";
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
  const {
    closeSidebar,
    setChatSidebarOpen,
    resetChat,
    setCurrentChatId,
    currentChatId,
    initializeChat,
    initializeNewChat,
  } = useGlobalState();
  const isMobile = useIsMobile();
  const deleteChat = useMutation(api.chats.deleteChat);

  // Use global currentChatId to determine if this item is active
  const isCurrentlyActive = currentChatId === id;

  const handleClick = () => {
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

  return (
    <div
      className={`group relative flex w-full cursor-pointer items-center rounded-lg p-2 hover:bg-sidebar-accent/50 focus:outline-hidden ${
        isCurrentlyActive
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : ""
      }`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      onClick={handleClick}
      title={title}
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
    </div>
  );
};

export default ChatItem;
