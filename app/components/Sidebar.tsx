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
import SidebarHeaderContent from "./SidebarHeader";
import { SidebarChatSections } from "./SidebarChatSections";
import { useProjects } from "../hooks/useProjects";
import { SidebarProjectListProvider } from "../contexts/SidebarProjectList";

/** Chat list data lifted from parent so the subscription stays active when sidebar closes. */
export type ChatListData = ReturnType<typeof useChats>;

// ChatList component content - receives data from parent to avoid refetch on open/close
const ChatListContent: FC<{ chatListData: ChatListData }> = ({
  chatListData,
}) => {
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const projectListData = useProjects();

  return (
    <div
      className="h-full min-w-0 overflow-y-auto overflow-x-hidden"
      ref={scrollContainerRef}
      data-testid="sidebar-chat-list-scroll-container"
    >
      <SidebarProjectListProvider
        projects={projectListData.results}
        paginationStatus={projectListData.status}
        loadMoreProjects={projectListData.loadMore}
      >
        <SidebarChatSections
          chats={chatListData.results || []}
          projects={projectListData.results}
          projectPaginationStatus={projectListData.status}
          loadMoreProjects={projectListData.loadMore}
          paginationStatus={chatListData.status}
          loadMore={chatListData.loadMore}
          containerRef={scrollContainerRef}
        />
      </SidebarProjectListProvider>
    </div>
  );
};

// Desktop-only sidebar content (requires SidebarProvider context)
const DesktopSidebarContent: FC<{
  isMobile: boolean;
  handleCloseSidebar: () => void;
  chatListData: ChatListData;
}> = ({ isMobile, handleCloseSidebar, chatListData }) => {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <Sidebar
      side="left"
      collapsible="icon"
      className={`${isMobile ? "w-full" : "w-[300px]"}`}
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
            <div
              className={`h-full transition-opacity duration-100 ease-out motion-reduce:transition-none ${
                isCollapsed
                  ? "pointer-events-none invisible opacity-0"
                  : "visible opacity-100 delay-200 motion-reduce:delay-0"
              }`}
              aria-hidden={isCollapsed}
              inert={isCollapsed}
              data-testid="sidebar-chat-list-visibility"
            >
              {/* Keep project subscriptions and section state alive across collapse. */}
              <ChatListContent chatListData={chatListData} />
            </div>
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

const MainSidebar: FC<{
  isMobileOverlay?: boolean;
  /** When provided (e.g. from ChatLayout), avoids refetching when sidebar opens/closes */
  chatListData?: ChatListData;
}> = ({ isMobileOverlay = false, chatListData: chatListDataProp }) => {
  const isMobile = useIsMobile();
  const { setChatSidebarOpen } = useGlobalState();
  // Use lifted data when provided; otherwise subscribe here (e.g. SharedChatView)
  const chatListDataFromHook = useChats(chatListDataProp === undefined);
  const chatListData = chatListDataProp ?? chatListDataFromHook;

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
            <ChatListContent chatListData={chatListData} />
          </div>

          {/* Footer */}
          <div className="p-2">
            <SidebarUserNav isCollapsed={false} />
          </div>
        </div>
      </>
    );
  }

  return (
    <DesktopSidebarContent
      isMobile={isMobile ?? false}
      handleCloseSidebar={handleCloseSidebar}
      chatListData={chatListData}
    />
  );
};

export default MainSidebar;
