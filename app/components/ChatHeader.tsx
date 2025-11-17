"use client";

import React, { useState } from "react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { PanelLeft, Sparkle, SquarePen, HatGlasses, Split } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { useRouter } from "next/navigation";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ShareDialog } from "./ShareDialog";

interface ChatHeaderProps {
  hasMessages: boolean;
  hasActiveChat: boolean;
  chatTitle?: string | null;
  id?: string;
  chatData?:
    | {
        title?: string;
        branched_from_chat_id?: string;
        share_id?: string;
        share_date?: number;
      }
    | null
    | undefined;
  chatSidebarOpen?: boolean;
  isExistingChat?: boolean;
  isChatNotFound?: boolean;
  branchedFromChatTitle?: string;
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
  branchedFromChatTitle,
}) => {
  const { user, loading } = useAuth();
  const {
    toggleChatSidebar,
    subscription,
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
  const [showShareDialog, setShowShareDialog] = useState(false);

  // Show sidebar toggle for logged-in users
  const showSidebarToggle = user && !loading;

  // Check if we're currently in a chat (use isExistingChat prop for accurate state)
  const isInChat = isExistingChat;

  // Check if this is a branched chat
  const isBranchedChat = !!chatData?.branched_from_chat_id;

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
              {!loading &&
                user &&
                !isCheckingProPlan &&
                subscription === "free" && (
                  <Button
                    onClick={handleUpgradeClick}
                    className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-premium-bg text-premium-text hover:bg-premium-hover border-0 transition-all duration-200"
                    size="default"
                  >
                    <Sparkle className="mr-2 h-4 w-4 fill-current" />
                    Upgrade plan
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
                          onClick={() =>
                            setTemporaryChatsEnabled(!temporaryChatsEnabled)
                          }
                          className="flex items-center gap-2 rounded-full px-3"
                        >
                          <HatGlasses className="size-5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent>
                        <p>
                          {temporaryChatsEnabled
                            ? "Turn off temporary chat"
                            : "Turn on temporary chat"}
                        </p>
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
              {!loading &&
                user &&
                !isCheckingProPlan &&
                subscription === "free" && (
                  <Button
                    onClick={handleUpgradeClick}
                    className="flex items-center gap-1 rounded-full py-2 ps-2.5 pe-3 text-sm font-medium bg-premium-bg text-premium-text hover:bg-premium-hover border-0 transition-all duration-200"
                    size="sm"
                  >
                    <Sparkle className="mr-1 h-3 w-3 fill-current" />
                    Upgrade plan
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
                        onClick={() =>
                          setTemporaryChatsEnabled(!temporaryChatsEnabled)
                        }
                        className="h-7 w-7 rounded-full"
                      >
                        <HatGlasses className="size-5" />
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p>
                        {temporaryChatsEnabled
                          ? "Turn off temporary chat"
                          : "Turn on temporary chat"}
                      </p>
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
      <>
        <ShareDialog
          open={showShareDialog}
          onOpenChange={setShowShareDialog}
          chatId={id || ""}
          chatTitle={chatTitle || ""}
          existingShareId={chatData?.share_id}
          existingShareDate={chatData?.share_date}
        />
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
                    {isChatNotFound ? (
                      ""
                    ) : !isExistingChat && temporaryChatsEnabled ? (
                      <>
                        Temporary Chat
                        <HatGlasses className="size-5" />
                      </>
                    ) : (
                      <>
                        {isBranchedChat && branchedFromChatTitle && (
                          <TooltipProvider delayDuration={300}>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Split className="size-4 flex-shrink-0 text-muted-foreground" />
                              </TooltipTrigger>
                              <TooltipContent>
                                <p className="text-xs">
                                  Branched from: {branchedFromChatTitle}
                                </p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        )}
                        {chatTitle ||
                          (isExistingChat && chatData === undefined
                            ? ""
                            : "New Chat")}
                      </>
                    )}
                  </span>
                </div>
                {/* Share button - only show for existing chats that aren't temporary, hide on mobile */}
                {isExistingChat &&
                  !temporaryChatsEnabled &&
                  id &&
                  chatTitle && (
                    <button
                      aria-label="Share"
                      data-testid="share-chat-button"
                      onClick={() => setShowShareDialog(true)}
                      className="relative mx-2 flex-shrink-0 rounded-full h-[34px] px-3 py-0 text-sm font-medium transition-colors hover:bg-[#ffffff1a] max-md:hidden"
                    >
                      <div className="flex w-full items-center justify-center gap-1.5">
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 20 20"
                          fill="currentColor"
                          xmlns="http://www.w3.org/2000/svg"
                          aria-label=""
                          className="-ms-0.5"
                        >
                          <path d="M2.66821 12.6663V12.5003C2.66821 12.1331 2.96598 11.8353 3.33325 11.8353C3.70052 11.8353 3.99829 12.1331 3.99829 12.5003V12.6663C3.99829 13.3772 3.9992 13.8707 4.03052 14.2542C4.0612 14.6298 4.11803 14.8413 4.19849 14.9993L4.2688 15.1263C4.44511 15.4137 4.69813 15.6481 5.00024 15.8021L5.13013 15.8577C5.2739 15.9092 5.46341 15.947 5.74536 15.97C6.12888 16.0014 6.62221 16.0013 7.33325 16.0013H12.6663C13.3771 16.0013 13.8707 16.0014 14.2542 15.97C14.6295 15.9394 14.8413 15.8825 14.9993 15.8021L15.1262 15.7308C15.4136 15.5545 15.6481 15.3014 15.802 14.9993L15.8577 14.8695C15.9091 14.7257 15.9469 14.536 15.97 14.2542C16.0013 13.8707 16.0012 13.3772 16.0012 12.6663V12.5003C16.0012 12.1332 16.2991 11.8355 16.6663 11.8353C17.0335 11.8353 17.3313 12.1331 17.3313 12.5003V12.6663C17.3313 13.3553 17.3319 13.9124 17.2952 14.3626C17.2624 14.7636 17.1974 15.1247 17.053 15.4613L16.9866 15.6038C16.7211 16.1248 16.3172 16.5605 15.8215 16.8646L15.6038 16.9866C15.227 17.1786 14.8206 17.2578 14.3625 17.2952C13.9123 17.332 13.3553 17.3314 12.6663 17.3314H7.33325C6.64416 17.3314 6.0872 17.332 5.63696 17.2952C5.23642 17.2625 4.87552 17.1982 4.53931 17.054L4.39673 16.9866C3.87561 16.7211 3.43911 16.3174 3.13501 15.8216L3.01294 15.6038C2.82097 15.2271 2.74177 14.8206 2.70435 14.3626C2.66758 13.9124 2.66821 13.3553 2.66821 12.6663ZM9.33521 12.5003V4.9388L7.13696 7.13704C6.87732 7.39668 6.45625 7.39657 6.19653 7.13704C5.93684 6.87734 5.93684 6.45631 6.19653 6.19661L9.52954 2.86263L9.6311 2.77962C9.73949 2.70742 9.86809 2.66829 10.0002 2.66829C10.1763 2.66838 10.3454 2.73819 10.47 2.86263L13.804 6.19661C14.0633 6.45628 14.0634 6.87744 13.804 7.13704C13.5443 7.39674 13.1222 7.39674 12.8625 7.13704L10.6653 4.93977V12.5003C10.6651 12.8673 10.3673 13.1652 10.0002 13.1654C9.63308 13.1654 9.33538 12.8674 9.33521 12.5003Z" />
                        </svg>
                        Share
                      </div>
                    </button>
                  )}
              </div>
            </div>
            <div className="flex-1 flex justify-end">
              {/* New Chat Button - Show on mobile when in a chat or when temporary chat is active */}
              {isMobile &&
                (isInChat || (!isExistingChat && temporaryChatsEnabled)) &&
                showSidebarToggle && (
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
      </>
    );
  }

  return null;
};

export default ChatHeader;
