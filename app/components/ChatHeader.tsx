"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { PanelLeft, Sparkle, SquarePen, HatGlasses } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

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
    temporaryChatsEnabled,
    setTemporaryChatsEnabled,
  } = useGlobalState();
  // Removed useUpgrade hook - we now redirect to pricing dialog instead
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

  const handleUpgradeClick = () => {
    // Navigate to pricing page
    redirectToPricing();
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

    // Always disable temporary chat for a new chat
    setTemporaryChatsEnabled(false);
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
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-[#F1F1FB] text-[#5D5BD0] hover:bg-[#E4E4F6] dark:bg-[#373669] dark:text-[#DCDBF6] dark:hover:bg-[#414071] border-0 transition-all duration-200"
                  size="default"
                >
                  <Sparkle className="mr-2 h-4 w-4 fill-current" />
                  Upgrade to Pro
                </Button>
              )}
            </div>
            <div className="flex flex-1 gap-2 justify-between items-center">
              <div className="flex gap-[40px]"></div>
              <div className="flex gap-2 items-center">
                {/* Temporary Chat Toggle - Desktop */}
                {!loading && user && (
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant={temporaryChatsEnabled ? "default" : "ghost"}
                          size="sm"
                          aria-label="Toggle temporary chats for new chats"
                          aria-pressed={temporaryChatsEnabled}
                          onClick={() => setTemporaryChatsEnabled(!temporaryChatsEnabled)}
                          className="flex items-center gap-2 rounded-full px-3"
                        >
                          <HatGlasses className="size-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>{temporaryChatsEnabled ? "Turn off temporary chat" : "Turn on temporary chat"}</p>
                      </TooltipContent>
                    </Tooltip>
                  </TooltipProvider>
                )}
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
                  onClick={handleUpgradeClick}
                  className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-[#F1F1FB] text-[#5D5BD0] hover:bg-[#E4E4F6] dark:bg-[#373669] dark:text-[#DCDBF6] dark:hover:bg-[#414071] border-0 transition-all duration-200"
                  size="sm"
                >
                  <Sparkle className="mr-1 h-3 w-3 fill-current" />
                  Upgrade to Pro
                </Button>
              )}
            </div>
            <div className="flex items-center gap-2">
              {/* Temporary Chat Toggle - Mobile */}
              {!loading && user && (
                <TooltipProvider>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button
                        variant={temporaryChatsEnabled ? "default" : "ghost"}
                        size="icon"
                        aria-label="Toggle temporary chats for new chats"
                        aria-pressed={temporaryChatsEnabled}
                        onClick={() => setTemporaryChatsEnabled(!temporaryChatsEnabled)}
                        className="h-7 w-7 rounded-full"
                      >
                        <HatGlasses className="size-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>{temporaryChatsEnabled ? "Turn off temporary chat" : "Turn on temporary chat"}</p>
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
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
                <span className="whitespace-nowrap text-ellipsis overflow-hidden flex items-center gap-2">
                  {isChatNotFound
                    ? ""
                    : !isExistingChat && temporaryChatsEnabled
                    ? (
                        <>
                          Temporary Chat
                          <HatGlasses className="size-5" />
                        </>
                      )
                    : chatTitle ||
                      (isExistingChat && chatData === undefined
                        ? ""
                        : "New Chat")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex-1 flex justify-end">
            {/* New Chat Button - Show on mobile when in a chat or when temporary chat is active */}
            {isMobile && (isInChat || (!isExistingChat && temporaryChatsEnabled)) && showSidebarToggle && (
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
