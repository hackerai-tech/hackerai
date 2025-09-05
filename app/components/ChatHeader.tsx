"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { PanelLeft, Sparkle, Loader2, SquarePen } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";

interface ChatHeaderProps {
  hasMessages: boolean;
  hasActiveChat: boolean;
  chatTitle?: string | null;
  id?: string;
  chatData?: { title?: string } | null | undefined;
  chatSidebarOpen?: boolean;
  isExistingChat?: boolean;
  isChatNotFound?: boolean;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  hasMessages,
  hasActiveChat,
  chatTitle,
  id,
  chatData,
  chatSidebarOpen = false,
  isExistingChat = false,
  isChatNotFound = false,
}) => {
  const { user, loading } = useAuth();
  const {
    toggleChatSidebar,
    hasProPlan,
    isCheckingProPlan,
    initializeNewChat,
    closeSidebar,
    setChatSidebarOpen,
  } = useGlobalState();
  const { upgradeLoading, handleUpgrade } = useUpgrade();
  const router = useRouter();
  const isMobile = useIsMobile();

  // Show sidebar toggle for logged-in users
  const showSidebarToggle = user && !loading;

  // Check if we're currently in a chat (use isExistingChat prop for accurate state)
  const isInChat = isExistingChat;

  const handleSignIn = () => {
    window.location.href = "/login";
  };

  const handleSignUp = () => {
    window.location.href = "/signup";
  };

  const handleNewChat = () => {
    // Close computer sidebar when creating new chat
    closeSidebar();

    // Close chat sidebar when creating new chat on mobile screens
    if (isMobile) {
      setChatSidebarOpen(false);
    }

    // Initialize new chat state using global state function
    initializeNewChat();

    // Navigate to homepage - Chat component will respond to global state changes
    router.push("/");
  };

  // Show empty state header when no messages and no active chat
  if (!hasMessages && !hasActiveChat) {
    return (
      <div className="flex-shrink-0">
        <header className="w-full px-6 max-sm:px-4 flex-shrink-0">
          {/* Desktop header */}
          <div className="py-[10px] flex gap-10 items-center justify-between max-md:hidden">
            <div className="flex items-center gap-2">
              {/* Removed sidebar toggle for desktop - handled by collapsed sidebar logo */}
              {/* Show upgrade button for logged-in users without pro plan */}
              {!loading && user && !isCheckingProPlan && !hasProPlan && (
                <Button
                  onClick={handleUpgrade}
                  disabled={upgradeLoading}
                  className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-[#F1F1FB] text-[#5D5BD0] hover:bg-[#E4E4F6] dark:bg-[#373669] dark:text-[#DCDBF6] dark:hover:bg-[#414071] border-0 transition-all duration-200"
                  size="default"
                >
                  {upgradeLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Upgrading...
                    </>
                  ) : (
                    <>
                      <Sparkle className="mr-2 h-4 w-4 fill-current" />
                      Upgrade to Pro
                    </>
                  )}
                </Button>
              )}
            </div>
            <div className="flex flex-1 gap-2 justify-between items-center">
              <div className="flex gap-[40px]"></div>
              <div className="flex gap-2 items-center">
                {/* Show sign in/up buttons for non-logged-in users */}
                {!loading && !user && (
                  <>
                    <Button
                      onClick={handleSignIn}
                      variant="default"
                      size="default"
                      className="min-w-[74px] rounded-[10px]"
                    >
                      Sign in
                    </Button>
                    <Button
                      onClick={handleSignUp}
                      variant="outline"
                      size="default"
                      className="min-w-16 rounded-[10px]"
                    >
                      Sign up
                    </Button>
                  </>
                )}
              </div>
            </div>
          </div>

          {/* Mobile header */}
          <div className="py-3 flex items-center justify-between md:hidden">
            <div className="flex items-center gap-2">
              {showSidebarToggle && !chatSidebarOpen && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Toggle chat sidebar"
                  onClick={toggleChatSidebar}
                  className="h-7 w-7 mr-2"
                >
                  <PanelLeft className="size-5" />
                </Button>
              )}
              {/* Show upgrade button for logged-in users without pro plan */}
              {!loading && user && !isCheckingProPlan && !hasProPlan && (
                <Button
                  onClick={handleUpgrade}
                  disabled={upgradeLoading}
                  className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-[#F1F1FB] text-[#5D5BD0] hover:bg-[#E4E4F6] dark:bg-[#373669] dark:text-[#DCDBF6] dark:hover:bg-[#414071] border-0 transition-all duration-200"
                  size="sm"
                >
                  {upgradeLoading ? (
                    <>
                      <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      Upgrading...
                    </>
                  ) : (
                    <>
                      <Sparkle className="mr-1 h-3 w-3 fill-current" />
                      Upgrade to Pro
                    </>
                  )}
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Show sign in/up buttons for non-logged-in users */}
              {!loading && !user && (
                <>
                  <Button
                    onClick={handleSignIn}
                    variant="default"
                    size="sm"
                    className="rounded-[10px]"
                  >
                    Sign in
                  </Button>
                  <Button
                    onClick={handleSignUp}
                    variant="outline"
                    size="sm"
                    className="rounded-[10px]"
                  >
                    Sign up
                  </Button>
                </>
              )}
            </div>
          </div>
        </header>
      </div>
    );
  }

  // Show chat header when there are messages or active chat
  if (hasMessages || hasActiveChat) {
    return (
      <div className="px-4 bg-background flex-shrink-0">
        <div className="sm:min-w-[390px] flex flex-row items-center justify-between pt-3 pb-1 gap-1 sticky top-0 z-10 bg-background flex-shrink-0">
          <div className="flex items-center flex-1">
            <div className="relative flex items-center">
              {/* Only show sidebar toggle on mobile - desktop uses collapsed sidebar logo */}
              {showSidebarToggle && !chatSidebarOpen && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Open sidebar"
                  onClick={toggleChatSidebar}
                  className="h-7 w-7 md:hidden"
                >
                  <PanelLeft className="size-5" />
                </Button>
              )}
            </div>
          </div>
          <div className="max-w-full sm:max-w-[768px] sm:min-w-[390px] flex w-full flex-col gap-[4px] overflow-hidden">
            <div className="w-full flex flex-row items-center justify-between flex-1 min-w-0 gap-[24px]">
              <div className="flex flex-row items-center gap-[6px] flex-1 min-w-0 text-foreground text-lg font-medium">
                <span className="whitespace-nowrap text-ellipsis overflow-hidden">
                  {isChatNotFound
                    ? ""
                    : chatTitle ||
                      (isExistingChat && chatData === undefined
                        ? ""
                        : "New Chat")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex-1 flex justify-end">
            {/* New Chat Button - Only show on mobile when in a chat */}
            {isMobile && isInChat && showSidebarToggle && (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Start new chat"
                onClick={handleNewChat}
                className="h-7 w-7"
              >
                <SquarePen className="size-5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return null;
};

export default ChatHeader;
