"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";
import type { ChatMode, SidebarFile } from "@/types/chat";

interface GlobalStateType {
  // Input state
  input: string;
  setInput: (value: string) => void;

  // Mode state
  mode: ChatMode;
  setMode: (mode: ChatMode) => void;

  // Chat title state
  chatTitle: string | null;
  setChatTitle: (title: string | null) => void;

  // Sidebar state
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarFile: SidebarFile | null;
  setSidebarFile: (file: SidebarFile | null) => void;

  // Utility methods
  clearInput: () => void;
  resetChat: () => void;
  openFileInSidebar: (file: SidebarFile) => void;
  closeSidebar: () => void;
}

const GlobalStateContext = createContext<GlobalStateType | undefined>(
  undefined,
);

interface GlobalStateProviderProps {
  children: ReactNode;
}

export const GlobalStateProvider: React.FC<GlobalStateProviderProps> = ({
  children,
}) => {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("agent");
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarFile, setSidebarFile] = useState<SidebarFile | null>(null);

  const clearInput = () => {
    setInput("");
  };

  const resetChat = () => {
    setInput("");
    setChatTitle(null);
  };

  const openFileInSidebar = (file: SidebarFile) => {
    setSidebarFile(file);
    setSidebarOpen(true);
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
    setSidebarFile(null);
  };

  const value: GlobalStateType = {
    input,
    setInput,
    mode,
    setMode,
    chatTitle,
    setChatTitle,
    sidebarOpen,
    setSidebarOpen,
    sidebarFile,
    setSidebarFile,
    clearInput,
    resetChat,
    openFileInSidebar,
    closeSidebar,
  };

  return (
    <GlobalStateContext.Provider value={value}>
      {children}
    </GlobalStateContext.Provider>
  );
};

export const useGlobalState = (): GlobalStateType => {
  const context = useContext(GlobalStateContext);
  if (context === undefined) {
    throw new Error("useGlobalState must be used within a GlobalStateProvider");
  }
  return context;
};
