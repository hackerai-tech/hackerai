"use client";

import { useState, useEffect, useMemo, FC } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  PanelLeft,
  Sidebar as SidebarIcon,
  SquarePen,
  Search,
} from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChats } from "../hooks/useChats";
import { MessageSearchDialog } from "./MessageSearchDialog";

interface SidebarHeaderContentProps {
  /** Function to handle closing the sidebar */
  handleCloseSidebar: () => void;
  /** Whether the sidebar is collapsed */
  isCollapsed: boolean;
  /** Whether this is being used in mobile overlay (without SidebarProvider) */
  isMobileOverlay?: boolean;
}

// Shared implementation component
interface SidebarHeaderContentImplProps {
  handleCloseSidebar: () => void;
  isCollapsed: boolean;
  toggleSidebar: () => void;
}

const SidebarHeaderContentImpl: FC<SidebarHeaderContentImplProps> = ({
  handleCloseSidebar,
  isCollapsed,
  toggleSidebar,
}) => {
  const isMobile = useIsMobile();
  const router = useRouter();
  const {
    setChatSidebarOpen,
    closeSidebar,
    initializeNewChat,
    setTemporaryChatsEnabled,
  } = useGlobalState();

  // Search dialog state
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Hover state for search button
  const [isSearchHovered, setIsSearchHovered] = useState(false);

  // Fetch chats when search dialog is opened to ensure data is available
  // This handles the case where user opens search without opening sidebar first
  useChats(isSearchOpen);

  // Detect if user is on Mac
  const isMac = useMemo(
    () => /macintosh|mac os x/i.test(navigator.userAgent),
    [],
  );

  // Platform-specific modifier key
  const modifierKey = isMac ? "⌘" : "Ctrl+";

  // Add keyboard shortcut for search (Cmd/Ctrl + K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setIsSearchOpen(true);
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

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

    // Always disable temporary chat for a new chat
    setTemporaryChatsEnabled(false);
    router.push("/");
  };

  const handleSearchOpen = () => {
    setIsSearchOpen(true);
  };

  const handleSearchClose = () => {
    setIsSearchOpen(false);
  };

  if (isCollapsed) {
    return (
      <>
        <div className="flex flex-col items-center p-2">
          {/* HackerAI Logo with hover sidebar toggle */}
          <div
            data-testid="sidebar-toggle"
            className="relative flex items-center justify-center mb-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 rounded"
            onClick={toggleSidebar}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                if (e.key === " ") {
                  e.preventDefault();
                }
                toggleSidebar();
              }
            }}
            tabIndex={0}
            role="button"
            aria-label="Expand sidebar"
          >
            <HackerAISVG theme="dark" scale={0.12} />
            {/* Sidebar icon shown on hover over entire collapsed sidebar */}
            <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity bg-sidebar/80 rounded">
              <SidebarIcon className="w-5 h-5" />
            </div>
          </div>

          {/* Sidebar Actions - Collapsed */}
          <div className="flex flex-col items-center">
            {/* New Chat Button - Collapsed */}
            <div className="p-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-sidebar-accent/50"
                onClick={handleNewChat}
                aria-label="Start new chat"
              >
                <SquarePen className="w-4 h-4" />
              </Button>
            </div>

            {/* Search Button - Collapsed */}
            <div className="p-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 hover:bg-sidebar-accent/50"
                onClick={handleSearchOpen}
                aria-label="Search chats"
                onMouseEnter={() => setIsSearchHovered(true)}
                onMouseLeave={() => setIsSearchHovered(false)}
              >
                <Search className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </div>

        {/* Search Dialog */}
        <MessageSearchDialog
          isOpen={isSearchOpen}
          onClose={handleSearchClose}
        />
      </>
    );
  }

  return (
    <>
      <div className="flex items-center justify-between p-2">
        <div className="flex items-center gap-2">
          {/* Show close button on mobile or desktop when expanded */}
          <Button
            data-testid="sidebar-toggle"
            variant="ghost"
            size="sm"
            className="h-8 w-8 p-0"
            onClick={handleCloseSidebar}
          >
            <PanelLeft className="size-5" />
          </Button>
        </div>
      </div>

      {/* Sidebar Actions - Expanded */}
      <div className="flex flex-col">
        {/* New Chat Button styled like a chat item */}
        <div className="px-2 py-1">
          <Button
            variant="ghost"
            className="group relative flex w-full justify-start items-center rounded-lg p-2 h-auto hover:bg-sidebar-accent/50 text-left"
            onClick={handleNewChat}
            aria-label="Start new chat"
          >
            <SquarePen className="w-4 h-4" />
            <div className="mr-2 flex-1 overflow-hidden text-clip whitespace-nowrap text-sm font-medium text-left">
              New chat
            </div>
          </Button>
        </div>

        {/* Search Button styled like a chat item */}
        <div className="px-2 py-1">
          <Button
            variant="ghost"
            className="relative flex w-full justify-start items-center rounded-lg p-2 h-auto hover:bg-sidebar-accent/50 text-left"
            onClick={handleSearchOpen}
            aria-label="Search chats"
            onMouseEnter={() => setIsSearchHovered(true)}
            onMouseLeave={() => setIsSearchHovered(false)}
          >
            <Search className="w-4 h-4" />
            <div className="mr-2 flex-1 overflow-hidden text-clip whitespace-nowrap text-sm font-medium text-left">
              Search chats
            </div>
            {/* Only show shortcut when hovering directly on the search button */}
            <div
              className={`text-xs transition-opacity ${
                isSearchHovered ? "opacity-100" : "opacity-0"
              }`}
            >
              {modifierKey}K
            </div>
          </Button>
        </div>
      </div>

      {/* Search Dialog */}
      <MessageSearchDialog isOpen={isSearchOpen} onClose={handleSearchClose} />
    </>
  );
};

// Desktop sidebar header component (requires SidebarProvider)
const DesktopSidebarHeaderContent: FC<
  Omit<SidebarHeaderContentProps, "isMobileOverlay">
> = ({ handleCloseSidebar, isCollapsed }) => {
  const { toggleSidebar } = useSidebar();
  return (
    <SidebarHeaderContentImpl
      handleCloseSidebar={handleCloseSidebar}
      isCollapsed={isCollapsed}
      toggleSidebar={toggleSidebar}
    />
  );
};

// Mobile sidebar header component (doesn't use SidebarProvider)
const MobileSidebarHeaderContent: FC<
  Omit<SidebarHeaderContentProps, "isMobileOverlay">
> = ({ handleCloseSidebar, isCollapsed }) => {
  const toggleSidebar = () => {}; // No-op for mobile
  return (
    <SidebarHeaderContentImpl
      handleCloseSidebar={handleCloseSidebar}
      isCollapsed={isCollapsed}
      toggleSidebar={toggleSidebar}
    />
  );
};

// Main component that conditionally renders based on context
const SidebarHeaderContent: FC<SidebarHeaderContentProps> = ({
  handleCloseSidebar,
  isCollapsed,
  isMobileOverlay = false,
}) => {
  if (isMobileOverlay) {
    return (
      <MobileSidebarHeaderContent
        handleCloseSidebar={handleCloseSidebar}
        isCollapsed={isCollapsed}
      />
    );
  }

  return (
    <DesktopSidebarHeaderContent
      handleCloseSidebar={handleCloseSidebar}
      isCollapsed={isCollapsed}
    />
  );
};

export default SidebarHeaderContent;
