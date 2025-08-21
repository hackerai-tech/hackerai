"use client";

import React, { createContext, useContext, useState, ReactNode } from "react";
import type { ChatMode, SidebarContent } from "@/types/chat";
import type { Todo } from "@/types";

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
  sidebarContent: SidebarContent | null;
  setSidebarContent: (content: SidebarContent | null) => void;

  // Todos state
  todos: Todo[];
  setTodos: (todos: Todo[]) => void;

  // UI state
  isTodoPanelExpanded: boolean;
  setIsTodoPanelExpanded: (expanded: boolean) => void;

  // Utility methods
  clearInput: () => void;
  resetChat: () => void;
  openSidebar: (content: SidebarContent) => void;
  updateSidebarContent: (updates: Partial<SidebarContent>) => void;
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
  const [sidebarContent, setSidebarContent] = useState<SidebarContent | null>(
    null,
  );
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);

  const clearInput = () => {
    setInput("");
  };

  const resetChat = () => {
    setInput("");
    setChatTitle(null);
    setTodos([]);
    setIsTodoPanelExpanded(false);
  };

  const openSidebar = (content: SidebarContent) => {
    setSidebarContent(content);
    setSidebarOpen(true);
  };

  const updateSidebarContent = (updates: Partial<SidebarContent>) => {
    setSidebarContent((current) => {
      if (current) {
        return { ...current, ...updates };
      }
      return current;
    });
  };

  const closeSidebar = () => {
    setSidebarOpen(false);
    setSidebarContent(null);
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
    sidebarContent,
    setSidebarContent,
    todos,
    setTodos,

    isTodoPanelExpanded,
    setIsTodoPanelExpanded,

    clearInput,
    resetChat,
    openSidebar,
    updateSidebarContent,
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
