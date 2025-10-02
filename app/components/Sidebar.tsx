"use client";

import { FC, useRef } from "react";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useChats } from "../hooks/useChats";
import { Sparkle } from "lucide-react";
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
import { redirectToPricing } from "../hooks/usePricingDialog";

// Upgrade banner component
const UpgradeBanner: FC<{ isCollapsed: boolean }> = ({ isCollapsed }) => {
  const { isCheckingProPlan, subscription } = useGlobalState();
  const isProUser = subscription !== "free";

  // Don't show for pro users or while checking
  if (isCheckingProPlan || isProUser) {
    return null;
  }

  const handleUpgrade = () => {
    redirectToPricing();
  };

  return (
    <div className="relative">
      {!isCollapsed && (
        <div className="relative rounded-t-2xl bg-[#F1F1FB] dark:bg-[#373669] backdrop-blur-sm transition-all duration-200">
          <div
            role="button"
            tabIndex={0}
            onClick={handleUpgrade}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleUpgrade();
              }
            }}
            className="group relative z-10 flex w-full items-center rounded-t-2xl py-2.5 px-4 text-xs border border-sidebar-border hover:bg-[#E4E4F6] dark:hover:bg-[#414071] transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none cursor-pointer"
            aria-label="Upgrade your plan"
          >
            <span className="flex items-center gap-2.5">
              <Sparkle className="h-4 w-4 text-[#5D5BD0] dark:text-[#DCDBF6] fill-current" />
              <span className="text-xs font-medium text-[#5D5BD0] dark:text-[#DCDBF6]">
                Upgrade your plan
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

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
        <UpgradeBanner isCollapsed={isCollapsed} />
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
          <UpgradeBanner isCollapsed={false} />
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
