"use client";

import React from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Plus, PanelLeft } from "lucide-react";
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
import SidebarHistory from "./SidebarHistory";
import SidebarUserNav from "./SidebarUserNav";
import SidebarUpgrade from "./SidebarUpgrade";

// Shared content components
const SidebarHeaderContent: React.FC<{
  handleNewChat: () => void;
  handleCloseSidebar: () => void;
}> = ({ handleNewChat, handleCloseSidebar }) => (
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

const MainSidebar: React.FC<{ isMobileOverlay?: boolean }> = ({
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
    initializeNewChat,
  } = useGlobalState();

  // Create ref for scroll container
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  // Get user's chats with pagination
  const paginatedChats = usePaginatedQuery(
    api.chats.getUserChats,
    user ? {} : "skip",
    { initialNumItems: 28 },
  );

  const handleNewChat = () => {
    // Close computer sidebar when creating new chat
    closeSidebar();

    // Close chat sidebar when creating new chat on mobile screens
    // On desktop, keep it open for better UX on large screens
    // On mobile screens, close it to give more space for the chat
    if (isMobile) {
      setChatSidebarOpen(false);
    }

    // Initialize new chat state using global state function
    initializeNewChat();

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
          <SidebarHeaderContent
            handleNewChat={handleNewChat}
            handleCloseSidebar={handleCloseSidebar}
          />
        </div>

        {/* Chat List */}
        <div className="flex-1 overflow-hidden">
          <div ref={scrollContainerRef} className="h-full overflow-y-auto">
            <SidebarHistory
              chats={paginatedChats.results || []}
              currentChatId={currentChatId}
              handleNewChat={handleNewChat}
              paginationStatus={paginatedChats.status}
              loadMore={paginatedChats.loadMore}
              containerRef={scrollContainerRef}
            />
          </div>
        </div>

        {/* Footer */}
        <SidebarUpgrade />
        <SidebarUserNav />
      </div>
    );
  }

  return (
    <Sidebar side="left" className={`${isMobile ? "w-full" : "w-72"}`}>
      <SidebarHeader>
        <SidebarHeaderContent
          handleNewChat={handleNewChat}
          handleCloseSidebar={handleCloseSidebar}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <div ref={scrollContainerRef} className="h-full overflow-y-auto">
              <SidebarHistory
                chats={paginatedChats.results || []}
                currentChatId={currentChatId}
                handleNewChat={handleNewChat}
                paginationStatus={paginatedChats.status}
                loadMore={paginatedChats.loadMore}
                containerRef={scrollContainerRef}
              />
            </div>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarUpgrade />
        <SidebarUserNav />
      </SidebarFooter>
    </Sidebar>
  );
};

export default MainSidebar;
