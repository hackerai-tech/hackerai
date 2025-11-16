"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";
import type { SidebarContent } from "@/types/chat";

interface SharedChatContextType {
  sidebarOpen: boolean;
  sidebarContent: SidebarContent | null;
  openSidebar: (content: SidebarContent) => void;
  closeSidebar: () => void;
}

const SharedChatContext = createContext<SharedChatContextType | undefined>(
  undefined,
);

export const SharedChatProvider = ({ children }: { children: ReactNode }) => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<SidebarContent | null>(
    null,
  );

  const openSidebar = (content: SidebarContent) => {
    setSidebarContent(content);
    setSidebarOpen(true);
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
  };

  return (
    <SharedChatContext.Provider
      value={{ sidebarOpen, sidebarContent, openSidebar, closeSidebar }}
    >
      {children}
    </SharedChatContext.Provider>
  );
};

export const useSharedChatContext = () => {
  const context = useContext(SharedChatContext);
  if (context === undefined) {
    throw new Error(
      "useSharedChatContext must be used within a SharedChatProvider",
    );
  }
  return context;
};
