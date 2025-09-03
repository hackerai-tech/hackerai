"use client";

import React from "react";
import { usePaginatedQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { SquarePen, PanelLeft, Sidebar as SidebarIcon } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";
import SidebarHistory from "./SidebarHistory";
import SidebarUserNav from "./SidebarUserNav";
import { HackerAISVG } from "@/components/icons/hackerai-svg";

// Component for mobile overlay header (no SidebarProvider context)
const MobileSidebarHeaderContent: React.FC<{
  handleNewChat: () => void;
  handleCloseSidebar: () => void;
}> = ({ handleNewChat, handleCloseSidebar }) => {
  return (
    <div className="flex items-center justify-between p-2">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
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
          <SquarePen className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

// Shared content components
const SidebarHeaderContent: React.FC<{
  handleNewChat: () => void;
  handleCloseSidebar: () => void;
  isCollapsed: boolean;
}> = ({ handleNewChat, handleCloseSidebar, isCollapsed }) => {
  const { toggleSidebar } = useSidebar();

  if (isCollapsed) {
    return (
      <div className="flex flex-col items-center p-2">
        {/* HackerAI Logo with hover sidebar toggle */}
        <div
          className="group/logo relative flex items-center justify-center mb-5 cursor-pointer"
          onClick={toggleSidebar}
        >
          <HackerAISVG theme="dark" scale={0.12} />
          {/* Sidebar icon shown on hover */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover/logo:opacity-100 transition-opacity bg-sidebar/80 rounded">
            <SidebarIcon className="w-5 h-5" />
          </div>
        </div>
        {/* New Chat Button */}
        <Button
          onClick={handleNewChat}
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
          title="New Chat"
        >
          <SquarePen className="w-4 h-4" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between p-2">
      <div className="flex items-center gap-2">
        {/* Show close button on mobile or desktop when expanded */}
        <Button
          variant="ghost"
          size="sm"
          className="h-8 w-8 p-0"
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
          <SquarePen className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
};

// Desktop-only sidebar content (requires SidebarProvider context)
const DesktopSidebarContent: React.FC<{
  user: ReturnType<typeof useAuth>["user"];
  isMobile: boolean;
  currentChatId: string | null;
  handleNewChat: () => void;
  handleCloseSidebar: () => void;
}> = ({ user, isMobile, currentChatId, handleNewChat, handleCloseSidebar }) => {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  // Create ref for scroll container
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);

  // Get user's chats with pagination
  const paginatedChats = usePaginatedQuery(
    api.chats.getUserChats,
    user ? {} : "skip",
    { initialNumItems: 28 },
  );

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      className={`${isMobile ? "w-full" : "w-72"}`}
    >
      <SidebarHeader>
        <SidebarHeaderContent
          handleNewChat={handleNewChat}
          handleCloseSidebar={handleCloseSidebar}
          isCollapsed={isCollapsed}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            {/* Hide chat list when collapsed */}
            {!isCollapsed && (
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
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarUserNav isCollapsed={isCollapsed} />
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
};

const MainSidebar: React.FC<{ isMobileOverlay?: boolean }> = ({
  isMobileOverlay = false,
}) => {
  const { user } = useAuth();
  const isMobile = useIsMobile();
  const router = useRouter();
  const { setChatSidebarOpen, closeSidebar, currentChatId, initializeNewChat } =
    useGlobalState();

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
          <MobileSidebarHeaderContent
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
        <SidebarUserNav isCollapsed={false} />
      </div>
    );
  }

  return (
    <DesktopSidebarContent
      user={user}
      isMobile={isMobile}
      currentChatId={currentChatId ?? null}
      handleNewChat={handleNewChat}
      handleCloseSidebar={handleCloseSidebar}
    />
  );
};

export default MainSidebar;
