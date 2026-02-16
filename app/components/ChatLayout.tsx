"use client";

import { useIsMobile } from "@/hooks/use-mobile";
import { useGlobalState } from "../contexts/GlobalState";
import { SidebarProvider } from "@/components/ui/sidebar";
import MainSidebar from "./Sidebar";

/**
 * Shared layout for chat routes: Chat Sidebar (left) + main content slot.
 * Stays mounted across / and /c/[id] navigation so the sidebar does not re-render.
 * Does NOT include the Computer Sidebar (right); that remains in ChatContent.
 */
export function ChatLayout({ children }: { children: React.ReactNode }) {
  const isMobile = useIsMobile();
  const { chatSidebarOpen, setChatSidebarOpen } = useGlobalState();

  return (
    <div className="flex min-h-0 flex-1 w-full overflow-hidden">
      {/* Chat Sidebar - Desktop: always mounted, collapses to icon rail when closed */}
      {!isMobile && (
        <div
          data-testid="sidebar"
          className={`relative z-10 min-w-0 shrink-0 overflow-hidden bg-sidebar transition-all duration-300 ${
            chatSidebarOpen ? "w-72" : "w-12"
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

      {/* Main content slot - pages render here */}
      <div className="flex min-h-0 flex-1 min-w-0 flex-col relative">
        {children}
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
