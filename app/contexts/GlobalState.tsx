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
import {
  mergeTodos as mergeTodosUtil,
  computeReplaceAssistantTodos,
} from "@/lib/utils/todo-utils";
import type { UploadedFileState } from "@/types/file";
import { useIsMobile } from "@/hooks/use-mobile";
import { chatSidebarStorage } from "@/lib/utils/sidebar-storage";
import type { Doc } from "@/convex/_generated/dataModel";

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

  // User chats state
  chats: Doc<"chats">[];
  setChats: (chats: Doc<"chats">[]) => void;

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
  replaceAssistantTodos: (todos: Todo[], sourceMessageId?: string) => void;

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
  activateChat: (chatId: string) => void;

  // Temporary chats preference
  temporaryChatsEnabled: boolean;
  setTemporaryChatsEnabled: (enabled: boolean) => void;

  // Register a chat reset function that will be invoked on initializeNewChat
  setChatReset: (fn: (() => void) | null) => void;
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
  const { user, entitlements } = useAuth();
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
  const [chats, setChats] = useState<Doc<"chats">[]>([]);
  const [hasProPlan, setHasProPlan] = useState(false);
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);
  const chatResetRef = useRef<(() => void) | null>(null);
  // Initialize temporary chats from URL parameter
  const [temporaryChatsEnabled, setTemporaryChatsEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("temporary-chat") === "true";
  });

  const mergeTodos = useCallback((newTodos: Todo[]) => {
    setTodos((currentTodos) => mergeTodosUtil(currentTodos, newTodos));
  }, []);
  const replaceAssistantTodos = useCallback(
    (incoming: Todo[], sourceMessageId?: string) => {
      setTodos((current) =>
        computeReplaceAssistantTodos(current, incoming, sourceMessageId),
      );
    },
    [],
  );
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

  // Derive pro status from current token entitlements
  useEffect(() => {
    if (!user) {
      setHasProPlan(false);
      return;
    }

    if (Array.isArray(entitlements)) {
      const hasPro = entitlements.includes("pro-monthly-plan");
      setHasProPlan(hasPro);
    }
  }, [user, entitlements]);

  // Refresh entitlements only when explicitly requested via URL param
  useEffect(() => {
    const refreshFromUrl = async () => {
      if (!user) {
        setHasProPlan(false);
        setIsCheckingProPlan(false);
        return;
      }

      if (typeof window === "undefined") return;

      const url = new URL(window.location.href);
      const shouldRefresh = url.searchParams.get("refresh") === "entitlements";
      if (!shouldRefresh) return;

      setIsCheckingProPlan(true);
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        const response = await fetch("/api/entitlements", {
          credentials: "include",
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        if (response.ok) {
          const data = await response.json();
          setHasProPlan(!!data.hasProPlan);
        } else {
          if (response.status === 401) {
            if (typeof window !== "undefined") {
              const { clientLogout } = await import("@/lib/utils/logout");
              clientLogout();
              return;
            }
          }
          setHasProPlan(false);
        }
      } catch {
        setHasProPlan(false);
      } finally {
        setIsCheckingProPlan(false);
        // Remove the refresh param to avoid repeated refreshes
        url.searchParams.delete("refresh");
        url.searchParams.delete("checkout");
        window.history.replaceState({}, "", url.toString());
      }
    };

    refreshFromUrl();
  }, [user]);

  // Listen for URL changes to sync temporary chat state
  useEffect(() => {
    const handleUrlChange = () => {
      if (typeof window === "undefined") return;
      const urlParams = new URLSearchParams(window.location.search);
      const urlTemporaryEnabled = urlParams.get("temporary-chat") === "true";

      // Only update state if it differs from URL to avoid infinite loops
      if (temporaryChatsEnabled !== urlTemporaryEnabled) {
        setTemporaryChatsEnabled(urlTemporaryEnabled);
      }
    };

    // Listen for popstate events (browser back/forward)
    window.addEventListener("popstate", handleUrlChange);

    return () => {
      window.removeEventListener("popstate", handleUrlChange);
    };
  }, [temporaryChatsEnabled]);

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

  const initializeChat = useCallback((chatId: string, _fromRoute?: boolean) => {
    setIsSwitchingChats(true);
    setCurrentChatId(chatId);
    setShouldFetchMessages(true);
    setHasActiveChat(true);
    // Clear text input only - preserve uploaded files across chat switches
    setInput("");
    setTodos([]);
    setIsTodoPanelExpanded(false);
  }, []);

  const initializeNewChat = useCallback(() => {
    // Allow chat component to reset its local state immediately
    if (chatResetRef.current) {
      chatResetRef.current();
    }
    setCurrentChatId(null);
    setShouldFetchMessages(false);
    setHasActiveChat(false);
    setTodos([]);
    setIsTodoPanelExpanded(false);
    setChatTitle(null);
  }, []);

  const setChatReset = useCallback((fn: (() => void) | null) => {
    chatResetRef.current = fn;
  }, []);

  const activateChat = useCallback((chatId: string) => {
    setCurrentChatId(chatId);
    setShouldFetchMessages(true);
    setHasActiveChat(true);
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

  // Custom setter for temporary chats that also updates URL
  const setTemporaryChatsEnabledWithUrl = useCallback((enabled: boolean) => {
    setTemporaryChatsEnabled(enabled);

    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (enabled) {
        url.searchParams.set("temporary-chat", "true");
      } else {
        url.searchParams.delete("temporary-chat");
      }
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

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
    chats,
    setChats,
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
    replaceAssistantTodos,

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
    activateChat,

    temporaryChatsEnabled,
    setTemporaryChatsEnabled: setTemporaryChatsEnabledWithUrl,
    setChatReset,
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
