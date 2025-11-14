"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SharedMessages } from "./SharedMessages";
import { Loader2, AlertCircle } from "lucide-react";
import Link from "next/link";
import { SharedChatProvider, useSharedChatContext } from "./SharedChatContext";
import { ComputerSidebarBase } from "@/app/components/ComputerSidebar";
import { useIsMobile } from "@/hooks/use-mobile";

// Desktop wrapper component that connects ComputerSidebarBase to SharedChatContext
function SharedComputerSidebarDesktop() {
  const { sidebarOpen, sidebarContent, closeSidebar } = useSharedChatContext();

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
        />
      )}
    </div>
  );
}

// Mobile wrapper component for full-screen sidebar overlay
function SharedComputerSidebarMobile() {
  const { sidebarOpen, sidebarContent, closeSidebar } = useSharedChatContext();

  if (!sidebarOpen) return null;

  return (
    <div className="flex fixed inset-0 z-50 bg-background items-center justify-center p-4">
      <div className="w-full max-w-4xl h-full">
        <ComputerSidebarBase
          sidebarOpen={sidebarOpen}
          sidebarContent={sidebarContent}
          closeSidebar={closeSidebar}
        />
      </div>
    </div>
  );
}

interface SharedChatViewProps {
  shareId: string;
}

// UUID format validation regex (matches v4 and other UUID versions)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SharedChatView({ shareId }: SharedChatViewProps) {
  const isMobile = useIsMobile();

  // Validate shareId format before making database query
  const isValidUUID = UUID_REGEX.test(shareId);

  const chat = useQuery(
    api.chats.getSharedChat,
    isValidUUID ? { shareId } : "skip"
  );
  const messages = useQuery(
    api.messages.getSharedMessages,
    chat ? { chatId: chat.id } : "skip"
  );

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
          <p className="text-sm text-muted-foreground">Loading shared chat...</p>
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
            This shared chat doesn&apos;t exist or is no longer available. It may
            have been unshared by the owner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <SharedChatProvider>
      <div className="h-screen bg-background flex flex-col overflow-hidden">
        {/* Main Content Area - matches normal chat structure */}
        <div className="flex flex-1 min-w-0 relative overflow-hidden">
          {/* Left side - Chat content */}
          <div className="flex flex-col flex-1 min-w-0 h-full">
            {/* Header */}
            <header className="border-b bg-background z-10 flex-shrink-0">
              <div className="container max-w-4xl mx-auto px-4 py-4">
                <div className="flex items-center justify-between">
                  <div>
                    <h1 className="text-lg font-semibold truncate">{chat.title}</h1>
                    <p className="text-xs text-muted-foreground mt-1">
                      Shared conversation • Read-only
                    </p>
                  </div>
                  <Link
                    href="/"
                    className="text-sm text-primary hover:underline"
                  >
                    Try HackerAI
                  </Link>
                </div>
              </div>
            </header>

            {/* Messages area - scrollable */}
            <div className="bg-background flex flex-col flex-1 relative min-h-0 overflow-hidden">
              <div className="flex-1 overflow-y-auto p-4">
                <div className="mx-auto w-full max-w-full sm:max-w-[768px] sm:min-w-[390px] flex flex-col space-y-4 pb-20">
                  {messages === undefined ? (
                    <div className="flex justify-center py-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      <SharedMessages messages={messages} shareDate={chat.share_date} />

                      {/* Footer inside scrollable area */}
                      <div className="text-center text-sm text-muted-foreground pt-6 border-t">
                        <p>
                          This is a shared conversation. Files and images are not included for
                          privacy.
                        </p>
                        <p className="mt-2">
                          Powered by{" "}
                          <Link href="/" className="text-white hover:underline">
                            HackerAI
                          </Link>
                        </p>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Desktop Computer Sidebar - fixed, independent scrolling */}
          {!isMobile && <SharedComputerSidebarDesktop />}
        </div>
      </div>

      {/* Mobile Computer Sidebar */}
      {isMobile && <SharedComputerSidebarMobile />}
    </SharedChatProvider>
  );
}
