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
import type { UploadedFileState } from "@/types/file";

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
  const [chatSidebarOpen, setChatSidebarOpen] = useState(false);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [hasProPlan, setHasProPlan] = useState(false);
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);

  const mergeTodos = useCallback((newTodos: Todo[]) => {
    setTodos((currentTodos) => mergeTodosUtil(currentTodos, newTodos));
  }, []);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);

  // Monitor connection state for debugging
  useEffect(() => {
    const handleOnline = () => {
      console.log("🌐 [GlobalState] Connection restored (online event):", {
        timestamp: new Date().toISOString(),
        currentChatId,
        shouldFetchMessages,
        hasActiveChat,
        isCheckingProPlan,
        isSwitchingChats,
      });

      // Reset potentially stuck states
      if (isCheckingProPlan) {
        console.log("🔄 [GlobalState] Resetting stuck isCheckingProPlan state");
        setIsCheckingProPlan(false);
      }

      if (isSwitchingChats) {
        console.log("🔄 [GlobalState] Resetting stuck isSwitchingChats state");
        setIsSwitchingChats(false);
      }

      // Re-trigger pro plan check if we have a user
      if (user && !isCheckingProPlan) {
        console.log(
          "🔄 [GlobalState] Re-triggering pro plan check after reconnection",
        );
        // The checkProPlan useEffect will handle this automatically
      }
    };

    const handleOffline = () => {
      console.log("📴 [GlobalState] Connection lost (offline event):", {
        timestamp: new Date().toISOString(),
        currentChatId,
        shouldFetchMessages,
        hasActiveChat,
      });
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, [
    currentChatId,
    shouldFetchMessages,
    hasActiveChat,
    isCheckingProPlan,
    isSwitchingChats,
    user,
  ]);

  // Check for pro plan on user change
  useEffect(() => {
    const checkProPlan = async () => {
      if (user) {
        console.log("💰 [GlobalState] Starting pro plan check:", {
          timestamp: new Date().toISOString(),
          userId: user.id,
          wasChecking: isCheckingProPlan,
          hadProPlan: hasProPlan,
        });

        setIsCheckingProPlan(true);
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => {
            console.warn(
              "⏰ [GlobalState] Pro plan check timeout, aborting...",
            );
            controller.abort();
          }, 10000); // 10 second timeout

          const response = await fetch("/api/entitlements", {
            credentials: "include",
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          if (!response.ok) {
            console.error("❌ [GlobalState] Entitlements API failed:", {
              timestamp: new Date().toISOString(),
              status: response.status,
              statusText: response.statusText,
              url: response.url,
            });
            const errorData = await response.json().catch(() => ({}));
            console.error("❌ [GlobalState] Error details:", errorData);
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          const data = await response.json();
          console.log("✅ [GlobalState] Pro plan check successful:", {
            timestamp: new Date().toISOString(),
            hasProPlan: data.hasProPlan || false,
            entitlements: data.entitlements || [],
          });
          setHasProPlan(data.hasProPlan || false);
        } catch (error) {
          console.error("💥 [GlobalState] Failed to check pro plan:", {
            timestamp: new Date().toISOString(),
            error: error instanceof Error ? error.message : error,
            name: error instanceof Error ? error.name : "Unknown",
            isAbortError: error instanceof Error && error.name === "AbortError",
            userId: user.id,
          });
          setHasProPlan(false);

          // Retry after delay if it's a network/timeout error
          if (
            error instanceof Error &&
            (error.name === "AbortError" || error.message.includes("fetch"))
          ) {
            console.log(
              "🔄 [GlobalState] Scheduling pro plan check retry in 5s...",
            );
            setTimeout(() => {
              if (user) {
                // Only retry if user is still authenticated
                checkProPlan();
              }
            }, 5000);
          }
        } finally {
          setIsCheckingProPlan(false);
        }
      } else {
        console.log("👤 [GlobalState] No user, resetting pro plan state");
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

  const initializeChat = useCallback(
    (chatId: string) => {
      console.log("🔧 [GlobalState] Initializing chat:", {
        timestamp: new Date().toISOString(),
        chatId,
        previousChatId: currentChatId,
        wasSwitching: isSwitchingChats,
        hadActiveChat: hasActiveChat,
        shouldFetchMessagesBefore: shouldFetchMessages,
      });

      setIsSwitchingChats(true);
      setCurrentChatId(chatId);
      setShouldFetchMessages(true);
      setHasActiveChat(true);
      setTodos([]);
      setIsTodoPanelExpanded(false);
    },
    [currentChatId, isSwitchingChats, hasActiveChat, shouldFetchMessages],
  );

  const initializeNewChat = useCallback(() => {
    console.log("🆕 [GlobalState] Initializing new chat:", {
      timestamp: new Date().toISOString(),
      previousChatId: currentChatId,
      wasSwitching: isSwitchingChats,
      hadActiveChat: hasActiveChat,
      shouldFetchMessagesBefore: shouldFetchMessages,
    });

    setCurrentChatId(null);
    setShouldFetchMessages(false);
    setHasActiveChat(false);
    setTodos([]);
    setIsTodoPanelExpanded(false);
    setUploadedFiles([]);
  }, [currentChatId, isSwitchingChats, hasActiveChat, shouldFetchMessages]);

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
