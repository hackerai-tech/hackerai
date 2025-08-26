"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { useGlobalState } from "../contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { Button } from "@/components/ui/button";

interface ChatItemProps {
  id: string;
  title: string;
  isActive?: boolean;
}

const ChatItem: React.FC<ChatItemProps> = ({
  id,
  title,
  isActive = false,
}) => {
  const router = useRouter();
  const { closeSidebar, setChatSidebarOpen } = useGlobalState();
  const isMobile = useIsMobile();

  const handleClick = () => {
    closeSidebar();

    if (isMobile) {
      setChatSidebarOpen(false);
    }

    router.push(`/c/${id}`);
  };

  return (
    <Button
      variant="ghost"
      onClick={handleClick}
      className={`flex items-center gap-2 p-3 h-auto w-full text-left justify-start ${
        isActive 
          ? "bg-sidebar-accent text-sidebar-accent-foreground" 
          : "hover:bg-sidebar-accent/50"
      }`}
      title={title}
    >
      <span className="text-sm font-medium truncate flex-1 min-w-0">
        {title}
      </span>
    </Button>
  );
};

export default ChatItem;

