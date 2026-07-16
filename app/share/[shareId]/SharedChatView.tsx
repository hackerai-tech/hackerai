"use client";

import { useConvex, useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SharedMessages, type SharedMessage } from "./SharedMessages";
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
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ChatInput } from "@/app/components/ChatInput";
import { upsertDraft } from "@/lib/utils/client-storage";
import { formatTaskTitle } from "@/app/utils/task-ui-copy";

// Desktop wrapper component that connects ComputerSidebarBase to SharedChatContext
function SharedComputerSidebarDesktop({
  messages,
}: {
  messages: SharedMessage[];
}) {
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
function SharedComputerSidebarMobile({
  messages,
}: {
  messages: SharedMessage[];
}) {
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

type SharedChat = {
  id: string;
  title: string;
  share_id: string;
  share_date: number;
  update_time: number;
};

type SharedSnapshot = {
  shareId: string;
  chat: SharedChat | null | undefined;
  messages: SharedMessage[] | undefined;
};

export function SharedChatView({ shareId }: SharedChatViewProps) {
  const isMobile = useIsMobile();
  const { user, loading: authLoading } = useAuth();
  const { chatSidebarOpen, setChatSidebarOpen, input } = useGlobalState();
  const router = useRouter();
  const convex = useConvex();
  const forkSharedChatMutation = useMutation(api.sharedChats.forkSharedChat);
  const [isForking, setIsForking] = useState(false);
  const [snapshot, setSnapshot] = useState<SharedSnapshot>(() => ({
    shareId,
    chat: undefined,
    messages: undefined,
  }));
  const loadGenerationRef = useRef(0);

  // Validate shareId format before making database query
  const isValidUUID = UUID_REGEX.test(shareId);

  useEffect(() => {
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;

    if (!isValidUUID) {
      return;
    }

    let cancelled = false;

    const loadSharedSnapshot = async () => {
      try {
        const nextChat = await convex.query(api.sharedChats.getSharedChat, {
          shareId,
        });
        if (cancelled || loadGenerationRef.current !== generation) return;

        if (!nextChat) {
          setSnapshot({ shareId, chat: null, messages: [] });
          return;
        }

        setSnapshot({ shareId, chat: nextChat, messages: undefined });

        const nextMessages = await convex.query(
          api.messages.getSharedMessages,
          {
            chatId: nextChat.id,
          },
        );
        if (cancelled || loadGenerationRef.current !== generation) return;
        setSnapshot({ shareId, chat: nextChat, messages: nextMessages });
      } catch (error) {
        console.error("Failed to load shared chat:", error);
        if (cancelled || loadGenerationRef.current !== generation) return;
        setSnapshot({ shareId, chat: null, messages: [] });
      }
    };

    void loadSharedSnapshot();

    return () => {
      cancelled = true;
    };
  }, [convex, isValidUUID, shareId]);

  const isSnapshotCurrent = snapshot.shareId === shareId;
  const chat = isSnapshotCurrent ? snapshot.chat : undefined;
  const messages = isSnapshotCurrent ? snapshot.messages : undefined;
  const taskTitle = chat?.title ? formatTaskTitle(chat.title) : chat?.title;

  // Update page title when chat loads
  useEffect(() => {
    if (taskTitle) {
      document.title = `${taskTitle} | HackerAI`;
    }

    return () => {
      document.title = "Shared Task | HackerAI";
    };
  }, [taskTitle]);

  const handleContinueChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isForking) return;
    setIsForking(true);
    try {
      const newChatId = await forkSharedChatMutation({ shareId });
      // Save the user's typed input as a draft for the new chat
      // so it appears in the textarea when they land on the new chat page
      if (input.trim()) {
        upsertDraft(newChatId, input);
        // Signal the chat page to auto-send the draft message
        sessionStorage.setItem("autoSendChatId", newChatId);
      }
      router.push(`/c/${newChatId}`);
    } catch (error) {
      console.error("Failed to fork shared chat:", error);
      setIsForking(false);
    }
  };

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
            Loading shared task...
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
          <h1 className="text-2xl font-semibold">Task not found</h1>
          <p className="text-sm text-muted-foreground">
            This shared task doesn&apos;t exist or is no longer available. It
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
            <Header chatTitle={formatTaskTitle(chat.title)} />
          </div>
        )}

        <div className="flex w-full h-full overflow-hidden">
          {/* Chat Sidebar - Desktop screens for logged users */}
          {!isMobile && !authLoading && user && (
            <div
              className={`transition-all duration-300 ${
                chatSidebarOpen
                  ? "w-[300px] flex-shrink-0"
                  : "w-12 flex-shrink-0"
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
                  chatTitle={formatTaskTitle(chat.title)}
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

                {/* Chat input for logged-in users to continue the conversation */}
                {!authLoading && user && messages && messages.length > 0 && (
                  <ChatInput
                    onSubmit={handleContinueChat}
                    onStop={() => {}}
                    onSendNow={() => {}}
                    status={isForking ? "submitted" : "ready"}
                    hasMessages={true}
                    isNewChat={false}
                    clearDraftOnSubmit={false}
                  />
                )}
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
