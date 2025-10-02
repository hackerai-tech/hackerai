"use client";

import { FC, useRef } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChats } from "../hooks/useChats";
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
import SidebarUserNav from "./SidebarUserNav";
import SidebarHistory from "./SidebarHistory";
import SidebarHeaderContent from "./SidebarHeader";
// ChatList component content
const ChatListContent: FC = () => {
  const { currentChatId } = useGlobalState();

  // Create ref for scroll container
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Get user's chats with pagination using the shared hook
  const paginatedChats = useChats();

  return (
    <div className={`h-full overflow-y-auto`} ref={scrollContainerRef}>
      <SidebarHistory
        chats={paginatedChats.results || []}
        currentChatId={currentChatId}
        paginationStatus={paginatedChats.status}
        loadMore={paginatedChats.loadMore}
        containerRef={scrollContainerRef}
      />
    </div>
  );
};

// Desktop-only sidebar content (requires SidebarProvider context)
const DesktopSidebarContent: FC<{
  isMobile: boolean;
  handleCloseSidebar: () => void;
}> = ({ isMobile, handleCloseSidebar }) => {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      className={`${isMobile ? "w-full" : "w-72"}`}
    >
      <SidebarHeader>
        <SidebarHeaderContent
          handleCloseSidebar={handleCloseSidebar}
          isCollapsed={isCollapsed}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            {/* Hide chat list when collapsed */}
            {!isCollapsed && <ChatListContent />}
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

const MainSidebar: FC<{ isMobileOverlay?: boolean }> = ({
  isMobileOverlay = false,
}) => {
  const isMobile = useIsMobile();
  const { setChatSidebarOpen } = useGlobalState();

  const handleCloseSidebar = () => {
    setChatSidebarOpen(false);
  };

  // Mobile overlay version - simplified without Sidebar wrapper
  if (isMobileOverlay) {
    return (
      <>
        <div className="flex flex-col h-full w-full bg-sidebar border-r">
          {/* Header with Actions */}
          <SidebarHeaderContent
            handleCloseSidebar={handleCloseSidebar}
            isCollapsed={false}
            isMobileOverlay={true}
          />

          {/* Chat List */}
          <div className="flex-1 overflow-hidden">
            <ChatListContent />
          </div>

          {/* Footer */}
          <SidebarUserNav isCollapsed={false} />
        </div>
      </>
    );
  }

  return (
    <DesktopSidebarContent
      isMobile={isMobile}
      handleCloseSidebar={handleCloseSidebar}
    />
  );
};

export default MainSidebar;
