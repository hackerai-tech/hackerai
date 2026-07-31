"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, type FC } from "react";
import { Button } from "@/components/ui/button";
import {
  PanelLeft,
  Sidebar as SidebarIcon,
  SquarePen,
  Search,
} from "lucide-react";
import { useSidebar } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { useGlobalState } from "../contexts/GlobalState";
import { useChats } from "../hooks/useChats";
import { useStartNewChat } from "../hooks/useStartNewChat";
import { MessageSearchDialog } from "./MessageSearchDialog";
import type { SubscriptionTier } from "@/types";

const SIDEBAR_PLAN_LABELS: Record<SubscriptionTier, string | null> = {
  free: null,
  pro: "Pro",
  "pro-plus": "Pro+",
  ultra: "Ultra",
  team: "Team",
};

interface SidebarActionTooltipProps {
  label: string;
  shortcut?: string;
  side?: "bottom" | "right";
}

const SidebarActionTooltip: FC<SidebarActionTooltipProps> = ({
  label,
  shortcut,
  side = "bottom",
}) => (
  <TooltipContent
    side={side}
    sideOffset={6}
    className="flex items-center gap-3 rounded-lg px-3 py-2 text-sm"
  >
    <span>{label}</span>
    {shortcut ? (
      <kbd className="text-primary-foreground/70 font-sans text-xs">
        {shortcut}
      </kbd>
    ) : null}
  </TooltipContent>
);

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
  isMobileOverlay: boolean;
  toggleSidebar: () => void;
}

const SidebarHeaderContentImpl: FC<SidebarHeaderContentImplProps> = ({
  handleCloseSidebar,
  isCollapsed,
  isMobileOverlay,
  toggleSidebar,
}) => {
  const startNewChat = useStartNewChat();
  const { subscription, isCheckingProPlan } = useGlobalState();

  // Search dialog state
  const [isSearchOpen, setIsSearchOpen] = useState(false);

  // Fetch chats when search dialog is opened to ensure data is available
  // This handles the case where user opens search without opening sidebar first
  useChats(isSearchOpen);

  // Detect if user is on Mac
  const isMac = useMemo(
    () => /macintosh|mac os x/i.test(navigator.userAgent),
    [],
  );

  const searchShortcutLabel = isMac ? "⌘K" : "Ctrl+K";
  const planLabel = isCheckingProPlan
    ? null
    : SIDEBAR_PLAN_LABELS[subscription];
  const showPlanWordmark = Boolean(planLabel) && !isMobileOverlay;

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
    startNewChat();
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
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="sidebar-toggle"
                variant="ghost"
                size="sm"
                className="mb-2 size-9 p-0 hover:bg-sidebar-accent/50"
                onClick={toggleSidebar}
                aria-label="Open sidebar"
              >
                <SidebarIcon className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <SidebarActionTooltip label="Toggle sidebar" side="right" />
          </Tooltip>

          {/* Sidebar Actions - Collapsed */}
          <div className="flex flex-col items-center gap-px">
            {/* New Chat Button - Collapsed */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 p-0 hover:bg-sidebar-accent/50"
                    onClick={handleNewChat}
                    aria-label="Start new task"
                  >
                    <SquarePen className="size-[18px]" />
                  </Button>
                </TooltipTrigger>
                <SidebarActionTooltip label="New task" side="right" />
              </Tooltip>
            </div>

            {/* Search Button - Collapsed */}
            <div>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="size-9 p-0 hover:bg-sidebar-accent/50"
                    onClick={handleSearchOpen}
                    aria-label="Search"
                  >
                    <Search className="size-[18px]" />
                  </Button>
                </TooltipTrigger>
                <SidebarActionTooltip
                  label="Search"
                  shortcut={searchShortcutLabel}
                  side="right"
                />
              </Tooltip>
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
      <div
        data-testid="sidebar-top-header"
        className={`sticky top-0 z-30 flex items-center justify-between bg-sidebar ${
          isMobileOverlay ? "h-14 ps-3 pe-2.5" : "h-10"
        }`}
      >
        <Link
          href="/"
          data-testid="sidebar-home"
          onClick={isMobileOverlay ? handleCloseSidebar : undefined}
          aria-label={
            planLabel ? `HackerAI ${planLabel} home` : "HackerAI home"
          }
          className={`flex h-9 items-center rounded-lg text-sidebar-foreground no-underline outline-none hover:bg-transparent hover:no-underline focus-visible:underline focus-visible:underline-offset-4 ${
            showPlanWordmark ? "px-2.5" : "w-9 justify-center"
          }`}
        >
          {showPlanWordmark ? (
            <span className="flex min-w-0 items-baseline gap-1 whitespace-nowrap text-[18px] leading-6 font-semibold">
              <span>HackerAI</span>
              <span className="font-medium text-sidebar-foreground/55">
                {planLabel}
              </span>
            </span>
          ) : (
            <HackerAISVG theme="dark" scale={isMobileOverlay ? 0.11 : 0.1} />
          )}
        </Link>

        <div className="flex items-center gap-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className="size-9 text-sidebar-foreground/65 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                onClick={handleSearchOpen}
                aria-label="Search"
              >
                <Search className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <SidebarActionTooltip
              label="Search"
              shortcut={searchShortcutLabel}
            />
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="sidebar-toggle"
                variant="ghost"
                size="icon-sm"
                className="size-9 text-sidebar-foreground/65 hover:bg-sidebar-accent/50 hover:text-sidebar-foreground"
                onClick={handleCloseSidebar}
                aria-label="Close sidebar"
              >
                <PanelLeft className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <SidebarActionTooltip label="Toggle sidebar" />
          </Tooltip>
        </div>
      </div>

      {/* Sidebar Actions - Expanded */}
      <div className={`flex flex-col ${isMobileOverlay ? "px-2" : ""}`}>
        {/* New Chat Button styled like a chat item */}
        <div className="py-1">
          <Button
            variant="ghost"
            className="group relative flex w-full justify-start items-center rounded-lg p-2 h-auto hover:bg-sidebar-accent/50 text-left"
            onClick={handleNewChat}
            aria-label="Start new task"
          >
            <SquarePen className="size-4" />
            <div className="mr-2 flex-1 overflow-hidden text-clip whitespace-nowrap text-sm font-medium text-left">
              New task
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
      isMobileOverlay={false}
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
      isMobileOverlay={true}
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
