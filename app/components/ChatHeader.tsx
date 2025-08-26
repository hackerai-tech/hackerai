"use client";

import React from "react";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { Button } from "@/components/ui/button";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { PanelLeft } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";

interface ChatHeaderProps {
  hasMessages: boolean;
  hasActiveChat: boolean;
  chatTitle?: string | null;
  id?: string;
  chatData?: { title?: string } | null | undefined;
  chatSidebarOpen?: boolean;
}

const ChatHeader: React.FC<ChatHeaderProps> = ({
  hasMessages,
  hasActiveChat,
  chatTitle,
  id,
  chatData,
  chatSidebarOpen = false,
}) => {
  const { user, loading } = useAuth();
  const { toggleChatSidebar } = useGlobalState();

  // Show sidebar toggle for logged-in users
  const showSidebarToggle = user && !loading;

  const handleSignIn = () => {
    window.location.href = "/login";
  };

  const handleSignUp = () => {
    window.location.href = "/signup";
  };

  // Show empty state header when no messages and no active chat
  if (!hasMessages && !hasActiveChat) {
    return (
      <div className="flex-shrink-0">
        <header className="w-full px-6 max-sm:px-4 flex-shrink-0">
          {/* Desktop header */}
          <div className="py-[10px] flex gap-10 items-center justify-between max-md:hidden">
            <div className="flex items-center gap-2">
              {showSidebarToggle && !chatSidebarOpen && (
                <div className="flex h-7 w-7 items-center justify-center cursor-pointer rounded-md hover:bg-muted/50 mr-2">
                  <PanelLeft
                    className="size-5 text-muted-foreground cursor-pointer"
                    onClick={toggleChatSidebar}
                  />
                </div>
              )}
              <HackerAISVG theme="dark" scale={0.15} />
              <span className="text-foreground text-xl font-semibold">
                HackerAI
              </span>
            </div>
            <div className="flex flex-1 gap-2 justify-between items-center">
              <div className="flex gap-[40px]"></div>
              {!loading && !user && (
                <div className="flex gap-2 items-center">
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
                </div>
              )}
            </div>
          </div>

          {/* Mobile header */}
          <div className="py-3 flex items-center justify-between md:hidden">
            <div className="flex items-center gap-2">
              {showSidebarToggle && !chatSidebarOpen && (
                <div className="flex h-7 w-7 items-center justify-center cursor-pointer rounded-md hover:bg-muted/50 mr-2">
                  <PanelLeft
                    className="size-5 text-muted-foreground cursor-pointer"
                    onClick={toggleChatSidebar}
                  />
                </div>
              )}
              <HackerAISVG theme="dark" scale={0.12} />
              <span className="text-foreground text-lg font-semibold">
                HackerAI
              </span>
            </div>
            {!loading && !user && (
              <div className="flex items-center gap-2">
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
              </div>
            )}
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
              {showSidebarToggle && !chatSidebarOpen && (
                <div className="flex h-7 w-7 items-center justify-center cursor-pointer rounded-md hover:bg-muted/50">
                  <PanelLeft
                    className="size-5 text-muted-foreground cursor-pointer"
                    onClick={toggleChatSidebar}
                  />
                </div>
              )}
            </div>
          </div>
          <div className="max-w-full sm:max-w-[768px] sm:min-w-[390px] flex w-full flex-col gap-[4px] overflow-hidden">
            <div className="w-full flex flex-row items-center justify-between flex-1 min-w-0 gap-[24px]">
              <div className="flex flex-row items-center gap-[6px] flex-1 min-w-0 text-foreground text-lg font-medium">
                <span className="whitespace-nowrap text-ellipsis overflow-hidden">
                  {chatTitle ||
                    (id && chatData === undefined ? "" : "New Chat")}
                </span>
              </div>
            </div>
          </div>
          <div className="flex-1"></div>
        </div>
      </div>
    );
  }

  return null;
};

export default ChatHeader;
