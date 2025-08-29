"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  ReactNode,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { ChatMode, SidebarContent } from "@/types/chat";
import type { Todo } from "@/types";
import { mergeTodos as mergeTodosUtil } from "@/lib/utils/todo-utils";


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

  // Current chat ID state
  currentChatId: string | null;
  setCurrentChatId: (chatId: string | null) => void;

  // Chat switching state
  isSwitchingChats: boolean;
  setIsSwitchingChats: (switching: boolean) => void;

  // Chat initialization state
  hasActiveChat: boolean;
  setHasActiveChat: (active: boolean) => void;
  shouldFetchMessages: boolean;
  setShouldFetchMessages: (should: boolean) => void;

  // Computer sidebar state (right side)
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarContent: SidebarContent | null;
  setSidebarContent: (content: SidebarContent | null) => void;

  // Chat sidebar state (left side)
  chatSidebarOpen: boolean;
  setChatSidebarOpen: (open: boolean) => void;

  // Todos state
  todos: Todo[];
  setTodos: (todos: Todo[]) => void;
  mergeTodos: (todos: Todo[]) => void;

  // UI state
  isTodoPanelExpanded: boolean;
  setIsTodoPanelExpanded: (expanded: boolean) => void;

  // Pro plan state
  hasProPlan: boolean;
  isCheckingProPlan: boolean;

  // Utility methods
  clearInput: () => void;
  openSidebar: (content: SidebarContent) => void;
  updateSidebarContent: (updates: Partial<SidebarContent>) => void;
  closeSidebar: () => void;
  toggleChatSidebar: () => void;
  initializeChat: (chatId: string, fromRoute?: boolean) => void;
  initializeNewChat: () => void;
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
  const { user } = useAuth();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<ChatMode>("ask");
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isSwitchingChats, setIsSwitchingChats] = useState(false);
  const [hasActiveChat, setHasActiveChat] = useState(false);
  const [shouldFetchMessages, setShouldFetchMessages] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<SidebarContent | null>(
    null,
  );
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [hasProPlan, setHasProPlan] = useState(false);
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);

  const mergeTodos = useCallback((newTodos: Todo[]) => {
    setTodos((currentTodos) => mergeTodosUtil(currentTodos, newTodos));
  }, []);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);

  // Check for pro plan on user change
  useEffect(() => {
    const checkProPlan = async () => {
      if (user) {
        setIsCheckingProPlan(true);
        try {
          const response = await fetch("/api/entitlements", {
            credentials: "include", // Ensure cookies are sent
          });

          if (!response.ok) {
            console.error(
              "❌ [GlobalState] Entitlements API failed:",
              response.status,
              response.statusText,
            );
            const errorData = await response.json().catch(() => ({}));
            console.error("❌ [GlobalState] Error details:", errorData);
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = await response.json();
          setHasProPlan(data.hasProPlan || false);
        } catch (error) {
          console.error("💥 [GlobalState] Failed to check pro plan:", error);
          setHasProPlan(false);
        } finally {
          setIsCheckingProPlan(false);
        }
      } else {
        setHasProPlan(false);
        setIsCheckingProPlan(false);
      }
    };

    checkProPlan();
  }, [user]);

  const clearInput = () => {
    setInput("");
  };

  const initializeChat = useCallback((chatId: string) => {
    setIsSwitchingChats(true);
    setCurrentChatId(chatId);
    setShouldFetchMessages(true);
    setHasActiveChat(true);
    setTodos([]);
    setIsTodoPanelExpanded(false);
  }, []);

  const initializeNewChat = useCallback(() => {
    setCurrentChatId(null);
    setShouldFetchMessages(false);
    setHasActiveChat(false);
    setTodos([]);
    setIsTodoPanelExpanded(false);
  }, []);

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

  const toggleChatSidebar = () => {
    setChatSidebarOpen((prev) => !prev);
  };

  const value: GlobalStateType = {
    input,
    setInput,
    mode,
    setMode,
    chatTitle,
    setChatTitle,
    currentChatId,
    setCurrentChatId,
    isSwitchingChats,
    setIsSwitchingChats,
    hasActiveChat,
    setHasActiveChat,
    shouldFetchMessages,
    setShouldFetchMessages,
    sidebarOpen,
    setSidebarOpen,
    sidebarContent,
    setSidebarContent,
    chatSidebarOpen,
    setChatSidebarOpen,
    todos,
    setTodos,
    mergeTodos,

    isTodoPanelExpanded,
    setIsTodoPanelExpanded,

    hasProPlan,
    isCheckingProPlan,

    clearInput,
    openSidebar,
    updateSidebarContent,
    closeSidebar,
    toggleChatSidebar,
    initializeChat,
    initializeNewChat,
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
