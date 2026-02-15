"use client";

import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import MainSidebar from "./Sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";

/**
 * Shared layout that renders the chat sidebar (desktop + mobile overlay) and a
 * main content slot. Used by the (chat) route group layout so the sidebar stays
 * mounted when navigating between / and /c/[id].
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const { chatSidebarOpen, setChatSidebarOpen } = useGlobalState();

  return (
    <div className="h-full bg-background flex flex-col overflow-hidden">
      <div className="flex w-full h-full overflow-hidden">
        {/* Chat Sidebar - Desktop: always mounted, collapses to icon rail when closed */}
        {!isMobile && (
          <div
            data-testid="sidebar"
            className={`transition-all duration-300 ${
              chatSidebarOpen ? "w-72 flex-shrink-0" : "w-12 flex-shrink-0"
            }`}
          >
            <SidebarProvider
              open={chatSidebarOpen}
              onOpenChange={setChatSidebarOpen}
              defaultOpen={true}
            >
              <MainSidebar />
            </SidebarProvider>
          </div>
        )}

        {/* Main Content Area */}
        <div className="flex flex-1 min-w-0 relative">{children}</div>
      </div>

      {/* Overlay Chat Sidebar - Mobile */}
      {isMobile && chatSidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 flex"
          onClick={() => setChatSidebarOpen(false)}
        >
          <div
            className="w-full max-w-80 h-full bg-background shadow-lg transform transition-transform duration-300 ease-in-out"
            onClick={(e) => e.stopPropagation()}
          >
            <MainSidebar isMobileOverlay={true} />
          </div>
          <div className="flex-1" />
        </div>
      )}
    </div>
  );
}
