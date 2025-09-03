"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
  ReactNode,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import type { ChatMode, SidebarContent } from "@/types/chat";
import type { Todo } from "@/types";
import { mergeTodos as mergeTodosUtil } from "@/lib/utils/todo-utils";
import type { UploadedFileState } from "@/types/file";
import { useIsMobile } from "@/hooks/use-mobile";
import { chatSidebarStorage } from "@/lib/utils/sidebar-storage";

interface GlobalStateType {
  // Input state
  input: string;
  setInput: (value: string) => void;

  // File upload state
  uploadedFiles: UploadedFileState[];
  setUploadedFiles: (files: UploadedFileState[]) => void;
  addUploadedFile: (file: UploadedFileState) => void;
  removeUploadedFile: (index: number) => void;
  updateUploadedFile: (
    index: number,
    updates: Partial<UploadedFileState>,
  ) => void;

  // Token tracking function
  getTotalTokens: () => number;

  // File upload status tracking
  isUploadingFiles: boolean;

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
  clearUploadedFiles: () => void;
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
  const isMobile = useIsMobile();
  const [input, setInput] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileState[]>([]);
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
  // Initialize chat sidebar state
  const [chatSidebarOpen, setChatSidebarOpen] = useState(() =>
    chatSidebarStorage.get(isMobile),
  );
  const [todos, setTodos] = useState<Todo[]>([]);
  const [hasProPlan, setHasProPlan] = useState(false);
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);

  const mergeTodos = useCallback((newTodos: Todo[]) => {
    setTodos((currentTodos) => mergeTodosUtil(currentTodos, newTodos));
  }, []);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);

  // Handle sidebar persistence and mobile transitions
  const prevIsMobile = useRef(isMobile);
  useEffect(() => {
    // Save state on desktop
    chatSidebarStorage.save(chatSidebarOpen, isMobile);

    // Close sidebar when transitioning from desktop to mobile
    if (!prevIsMobile.current && isMobile && chatSidebarOpen) {
      setChatSidebarOpen(false);
    }

    prevIsMobile.current = isMobile;
  }, [chatSidebarOpen, isMobile]);

  // Check for pro plan on user change
  useEffect(() => {
    const checkProPlan = async () => {
      if (user) {
        setIsCheckingProPlan(true);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 10000); // 10 second timeout

          const response = await fetch("/api/entitlements", {
            credentials: "include",
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = await response.json();
          setHasProPlan(data.hasProPlan || false);
        } catch (error) {
          setHasProPlan(false);

          // Retry after delay if it's a network/timeout error
          if (
            error instanceof Error &&
            (error.name === "AbortError" || error.message.includes("fetch"))
          ) {
            setTimeout(() => {
              if (user) {
                checkProPlan();
              }
            }, 5000);
          }
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

  const clearUploadedFiles = () => {
    setUploadedFiles([]);
  };

  // Calculate total tokens from all files that have tokens
  const getTotalTokens = useCallback((): number => {
    return uploadedFiles.reduce((total, file) => {
      return file.tokens ? total + file.tokens : total;
    }, 0);
  }, [uploadedFiles]);

  // Check if any files are currently uploading
  const isUploadingFiles = uploadedFiles.some((file) => file.uploading);

  const addUploadedFile = useCallback((file: UploadedFileState) => {
    setUploadedFiles((prev) => [...prev, file]);
  }, []);

  const removeUploadedFile = useCallback((index: number) => {
    setUploadedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateUploadedFile = useCallback(
    (index: number, updates: Partial<UploadedFileState>) => {
      setUploadedFiles((prev) =>
        prev.map((file, i) => (i === index ? { ...file, ...updates } : file)),
      );
    },
    [],
  );

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
    setUploadedFiles([]);
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
    setChatSidebarOpen((prev: boolean) => !prev);
  };

  const value: GlobalStateType = {
    input,
    setInput,
    uploadedFiles,
    setUploadedFiles,
    addUploadedFile,
    removeUploadedFile,
    updateUploadedFile,
    getTotalTokens,
    isUploadingFiles,
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
    clearUploadedFiles,
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
