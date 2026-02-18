"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SharedMessages } from "./SharedMessages";
import { Loader2, AlertCircle } from "lucide-react";
import { SharedChatProvider, useSharedChatContext } from "./SharedChatContext";
import { ComputerSidebarBase } from "@/app/components/ComputerSidebar";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import Header from "@/app/components/Header";
import ChatHeader from "@/app/components/ChatHeader";
import MainSidebar from "@/app/components/Sidebar";
import { SidebarProvider } from "@/components/ui/sidebar";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useEffect } from "react";

// Desktop wrapper component that connects ComputerSidebarBase to SharedChatContext
function SharedComputerSidebarDesktop({ messages }: { messages: any[] }) {
  const { sidebarOpen, sidebarContent, closeSidebar, openSidebar } =
    useSharedChatContext();

  return (
    <div
      className={`transition-all duration-300 min-w-0 ${
        sidebarOpen ? "w-1/2 flex-shrink-0" : "w-0 overflow-hidden"
      }`}
    >
      {sidebarOpen && (
        <ComputerSidebarBase
          sidebarOpen={sidebarOpen}
          sidebarContent={sidebarContent}
          closeSidebar={closeSidebar}
          messages={messages}
          onNavigate={openSidebar}
        />
      )}
    </div>
  );
}

// Mobile wrapper component for full-screen sidebar overlay
function SharedComputerSidebarMobile({ messages }: { messages: any[] }) {
  const { sidebarOpen, sidebarContent, closeSidebar, openSidebar } =
    useSharedChatContext();

  if (!sidebarOpen) return null;

  return (
    <div className="flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
      <div className="w-full max-w-4xl h-full">
        <ComputerSidebarBase
          sidebarOpen={sidebarOpen}
          sidebarContent={sidebarContent}
          closeSidebar={closeSidebar}
          messages={messages}
          onNavigate={openSidebar}
        />
      </div>
    </div>
  );
}

interface SharedChatViewProps {
  shareId: string;
}

// UUID format validation regex (matches v4 and other UUID versions)
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SharedChatView({ shareId }: SharedChatViewProps) {
  const isMobile = useIsMobile();
  const { user, loading: authLoading } = useAuth();
  const { chatSidebarOpen, setChatSidebarOpen } = useGlobalState();

  // Validate shareId format before making database query
  const isValidUUID = UUID_REGEX.test(shareId);

  const chat = useQuery(
    api.sharedChats.getSharedChat,
    isValidUUID ? { shareId } : "skip",
  );
  const messages = useQuery(
    api.messages.getSharedMessages,
    chat ? { chatId: chat.id } : "skip",
  );

  // Update page title when chat loads
  useEffect(() => {
    if (chat?.title) {
      document.title = `${chat.title} | HackerAI`;
    }

    return () => {
      document.title = "Shared Chat | HackerAI";
    };
  }, [chat?.title]);

  // Invalid UUID format - show not found immediately
  if (!isValidUUID) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4 max-w-md text-center p-6">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Invalid share link</h1>
          <p className="text-sm text-muted-foreground">
            This share link appears to be malformed. Please check the URL and
            try again.
          </p>
        </div>
      </div>
    );
  }

  // Loading state
  if (chat === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            Loading shared chat...
          </p>
        </div>
      </div>
    );
  }

  // Chat not found or not shared
  if (chat === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4 max-w-md text-center p-6">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Chat not found</h1>
          <p className="text-sm text-muted-foreground">
            This shared chat doesn&apos;t exist or is no longer available. It
            may have been unshared by the owner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <SharedChatProvider>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        {/* Header for unlogged users */}
        {!authLoading && !user && (
          <div className="flex-shrink-0">
            <Header chatTitle={chat.title} />
          </div>
        )}

        <div className="flex w-full h-full overflow-hidden">
          {/* Chat Sidebar - Desktop screens for logged users */}
          {!isMobile && !authLoading && user && (
            <div
              className={`transition-all duration-300 ${
                chatSidebarOpen ? "w-72 flex-shrink-0" : "w-12 flex-shrink-0"
              }`}
            >
              <SidebarProvider
                open={chatSidebarOpen}
                onOpenChange={setChatSidebarOpen}
                defaultOpen={false}
              >
                <MainSidebar />
              </SidebarProvider>
            </div>
          )}

          {/* Main Content Area - matches normal chat structure */}
          <div className="flex flex-1 min-w-0 relative overflow-hidden">
            {/* Left side - Chat content */}
            <div className="flex flex-col flex-1 min-w-0 h-full">
              {/* ChatHeader for logged users - always show title */}
              {(authLoading || user) && (
                <ChatHeader
                  hasMessages={true}
                  hasActiveChat={true}
                  chatTitle={chat.title}
                  isExistingChat={true}
                  isChatNotFound={false}
                  chatSidebarOpen={chatSidebarOpen}
                />
              )}

              {/* Messages area - scrollable */}
              <div className="bg-background flex flex-col flex-1 relative min-h-0 overflow-hidden">
                <div className="flex-1 overflow-y-auto p-4">
                  <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20">
                    {messages === undefined ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : (
                      <SharedMessages
                        messages={messages}
                        shareDate={chat.share_date}
                      />
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Desktop Computer Sidebar - fixed, independent scrolling */}
            {!isMobile && (
              <SharedComputerSidebarDesktop messages={messages || []} />
            )}
          </div>
        </div>

        {/* Mobile Computer Sidebar */}
        {isMobile && <SharedComputerSidebarMobile messages={messages || []} />}

        {/* Overlay Chat Sidebar - Mobile screens for logged users */}
        {isMobile && !authLoading && user && chatSidebarOpen && (
          <div className="fixed inset-0 z-50 bg-background">
            <SidebarProvider
              open={chatSidebarOpen}
              onOpenChange={setChatSidebarOpen}
              defaultOpen={false}
            >
              <MainSidebar />
            </SidebarProvider>
          </div>
        )}
      </div>
    </SharedChatProvider>
  );
}
