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
import type { SubscriptionTier } from "@/types";
import { readChatMode, writeChatMode } from "@/lib/utils/client-storage";

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

  // Chat mode state
  chatMode: ChatMode;
  setChatMode: (mode: ChatMode) => void;

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

  // Subscription state
  subscription: SubscriptionTier;
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

  // Team pricing dialog state
  teamPricingDialogOpen: boolean;
  setTeamPricingDialogOpen: (open: boolean) => void;

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
  const prevIsMobile = useRef(isMobile);
  const [input, setInput] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileState[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>(() => {
    const saved = readChatMode();
    return saved === "ask" || saved === "agent" ? saved : "ask";
  });
  const [chatTitle, setChatTitle] = useState<string | null>(null);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [isSwitchingChats, setIsSwitchingChats] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<SidebarContent | null>(
    null,
  );

  // Persist chat mode preference to localStorage on change
  useEffect(() => {
    writeChatMode(chatMode);
  }, [chatMode]);
  // Initialize chat sidebar state
  const [chatSidebarOpen, setChatSidebarOpen] = useState(() =>
    chatSidebarStorage.get(isMobile),
  );
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);
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
  const [chats, setChats] = useState<Doc<"chats">[]>([]);
  const [subscription, setSubscription] = useState<SubscriptionTier>("free");
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);
  const chatResetRef = useRef<(() => void) | null>(null);
  // Initialize temporary chats from URL parameter
  const [temporaryChatsEnabled, setTemporaryChatsEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("temporary-chat") === "true";
  });
  // Initialize team pricing dialog from URL hash
  const [teamPricingDialogOpen, setTeamPricingDialogOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.location.hash === "#team-pricing-seat-selection";
  });

  useEffect(() => {
    // Save state on desktop
    chatSidebarStorage.save(chatSidebarOpen, isMobile);

    // Close sidebar when transitioning from desktop to mobile
    if (!prevIsMobile.current && isMobile && chatSidebarOpen) {
      setChatSidebarOpen(false);
    }

    prevIsMobile.current = isMobile;
  }, [chatSidebarOpen, isMobile]);

  // Derive subscription tier from current token entitlements
  // Prefer normalized entitlements ("pro-plan", "ultra-plan"); fall back to monthly/yearly keys for backward compatibility
  useEffect(() => {
    if (!user) {
      setSubscription("free");
      return;
    }

    if (Array.isArray(entitlements)) {
      const hasUltra =
        entitlements.includes("ultra-plan") ||
        entitlements.includes("ultra-monthly-plan") ||
        entitlements.includes("ultra-yearly-plan");
      const hasTeam = entitlements.includes("team-plan");
      const hasPro =
        entitlements.includes("pro-plan") ||
        entitlements.includes("pro-monthly-plan") ||
        entitlements.includes("pro-yearly-plan");
      setSubscription(
        hasUltra ? "ultra" : hasTeam ? "team" : hasPro ? "pro" : "free",
      );
    }
  }, [user, entitlements]);

  // Refresh entitlements only when explicitly requested via URL param
  useEffect(() => {
    const refreshFromUrl = async () => {
      if (!user) {
        setSubscription("free");
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
          const tier = data.subscription as SubscriptionTier | undefined;
          setSubscription(
            tier === "ultra" || tier === "team" || tier === "pro"
              ? tier
              : "free",
          );
        } else {
          if (response.status === 401) {
            if (typeof window !== "undefined") {
              const { clientLogout } = await import("@/lib/utils/logout");
              clientLogout();
              return;
            }
          }
          setSubscription("free");
        }
      } catch {
        setSubscription("free");
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

  // Listen for hash changes to sync team pricing dialog state
  useEffect(() => {
    const handleHashChange = () => {
      if (typeof window === "undefined") return;
      const shouldOpen =
        window.location.hash === "#team-pricing-seat-selection";

      // Only update state if it differs to avoid infinite loops
      if (teamPricingDialogOpen !== shouldOpen) {
        setTeamPricingDialogOpen(shouldOpen);
      }
    };

    // Listen for hash changes
    window.addEventListener("hashchange", handleHashChange);
    window.addEventListener("popstate", handleHashChange);

    return () => {
      window.removeEventListener("hashchange", handleHashChange);
      window.removeEventListener("popstate", handleHashChange);
    };
  }, [teamPricingDialogOpen]);

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
    setTodos([]);
    setIsTodoPanelExpanded(false);
    setChatTitle(null);
  }, []);

  const setChatReset = useCallback((fn: (() => void) | null) => {
    chatResetRef.current = fn;
  }, []);

  const activateChat = useCallback((chatId: string) => {
    setCurrentChatId(chatId);
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
    chatMode,
    setChatMode,
    chatTitle,
    setChatTitle,
    currentChatId,
    setCurrentChatId,
    chats,
    setChats,
    isSwitchingChats,
    setIsSwitchingChats,
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

    subscription,
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

    teamPricingDialogOpen,
    setTeamPricingDialogOpen,

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
