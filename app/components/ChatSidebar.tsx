"use client";

import React from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import ChatItem from "./ChatItem";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare, PanelLeft } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
} from "@/components/ui/sidebar";
import UserDropdownMenu from "./UserDropdownMenu";

// Shared content components
const ChatSidebarHeader: React.FC<{
  handleNewChat: () => void;
  handleCloseSidebar: () => void;
  isMobile: boolean;
}> = ({ handleNewChat, handleCloseSidebar, isMobile }) => (
  <div className="flex items-center justify-between p-2">
    <div className="flex items-center gap-2">
      <Button
        variant="ghost"
        size="sm"
        className="h-7 w-7 p-0"
        onClick={handleCloseSidebar}
      >
        <PanelLeft className="size-5 text-muted-foreground" />
      </Button>
    </div>
    <div className="flex items-center gap-1">
      <Button
        onClick={handleNewChat}
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        title="New Chat"
      >
        <Plus className="w-4 h-4" />
      </Button>
    </div>
  </div>
);

const ChatSidebarList: React.FC<{
  chats: any;
  currentChatId: string | null;
  handleNewChat: () => void;
}> = ({ chats, currentChatId, handleNewChat }) => {
  if (chats === undefined) {
    // Loading state
    return (
      <div className="p-2">
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="animate-pulse">
              <div className="h-4 bg-sidebar-accent rounded w-3/4 mb-2"></div>
              <div className="h-3 bg-sidebar-accent rounded w-1/2"></div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (chats === null || chats.length === 0) {
    // Empty state
    return (
      <div className="flex flex-col items-center justify-center h-full p-6 text-center">
        <MessageSquare className="w-12 h-12 text-sidebar-accent-foreground mb-4" />
        <h3 className="text-lg font-medium text-sidebar-foreground mb-2">
          No chats yet
        </h3>
        <p className="text-sm text-sidebar-accent-foreground mb-4">
          Start a conversation to see your chat history here
        </p>
        <Button onClick={handleNewChat} variant="default" size="sm">
          <Plus className="w-4 h-4 mr-2" />
          New Chat
        </Button>
      </div>
    );
  }

  // Chat list with buttons (same for mobile and desktop)
  return (
    <div className="p-2 space-y-1">
      {chats.map((chat: any) => (
        <ChatItem
          key={chat._id}
          id={chat.id}
          title={chat.title}
          isActive={currentChatId === chat.id}
        />
      ))}
    </div>
  );
};

const ChatSidebar: React.FC<{ isMobileOverlay?: boolean }> = ({
  isMobileOverlay = false,
}) => {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const router = useRouter();
  const {
    resetChat,
    setChatSidebarOpen,
    closeSidebar,
    setCurrentChatId,
    currentChatId,
  } = useGlobalState();

  // Get user's chats
  const chats = useQuery(api.chats.getUserChats, user ? {} : "skip");

  const handleNewChat = () => {
    // Close computer sidebar when creating new chat
    closeSidebar();

    // Close chat sidebar when creating new chat on mobile screens
    // On desktop, keep it open for better UX on large screens
    // On mobile screens, close it to give more space for the chat
    if (isMobile) {
      setChatSidebarOpen(false);
    }

    // Reset state first to ensure clean transition
    resetChat();
    setCurrentChatId(null);

    // Navigate to homepage
    router.push("/");
  };

  const handleCloseSidebar = () => {
    setChatSidebarOpen(false);
  };

  // Mobile overlay version - simplified without Sidebar wrapper
  if (isMobileOverlay) {
    return (
      <div className="flex flex-col h-full w-full bg-sidebar border-r">
        {/* Header */}
        <div className="p-2">
          <ChatSidebarHeader
            handleNewChat={handleNewChat}
            handleCloseSidebar={handleCloseSidebar}
            isMobile={isMobile}
          />
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-hidden">
          <div className="h-full overflow-y-auto">
            <ChatSidebarList
              chats={chats}
              currentChatId={currentChatId}
              handleNewChat={handleNewChat}
            />
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-sidebar-border">
          <UserDropdownMenu />
        </div>
      </div>
    );
  }

  return (
    <Sidebar side="left" className={`${isMobile ? "w-full" : "w-72"}`}>
      <SidebarHeader>
        <ChatSidebarHeader
          handleNewChat={handleNewChat}
          handleCloseSidebar={handleCloseSidebar}
          isMobile={isMobile}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <ChatSidebarList
              chats={chats}
              currentChatId={currentChatId}
              handleNewChat={handleNewChat}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <div className="border-t border-sidebar-border">
          <UserDropdownMenu />
        </div>{" "}
      </SidebarFooter>
    </Sidebar>
  );
};

export default ChatSidebar;
