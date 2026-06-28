"use client";

import React, {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  ReactNode,
} from "react";
import { useAccessToken, useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  type ChatMode,
  type SelectedModel,
  type SidebarContent,
  type QueuedMessage,
  type QueueBehavior,
  type SandboxPreference,
  isChatMode,
} from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import type { Todo } from "@/types";
import {
  mergeTodos as mergeTodosUtil,
  computeReplaceAssistantTodos,
  type TodoLike,
} from "@/lib/utils/todo-utils";
import type { UploadedFileState } from "@/types/file";
import type { FileMessagePart } from "@/types/file";
import { useIsMobile } from "@/hooks/use-mobile";
import { useSandboxPreference } from "@/app/hooks/useSandboxPreference";
import { isTauriEnvironment } from "@/app/hooks/useTauri";
import { resolveSubscriptionTier } from "@/lib/auth/entitlements";
import { clearSharedToken, setSharedToken } from "@/lib/auth/shared-token";
import { chatSidebarStorage } from "@/lib/utils/sidebar-storage";
import type { Id } from "@/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import type { SubscriptionTier } from "@/types";
import { v4 as uuidv4 } from "uuid";
import { toast } from "sonner";
import {
  readChatMode,
  writeChatMode,
  readSelectedModel,
  writeSelectedModel,
  cleanupExpiredDrafts,
  markHasAuthenticatedBefore,
} from "@/lib/utils/client-storage";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import {
  getAgentFirstDefaultDecision,
  normalizeAgentFirstSandboxType,
} from "@/lib/activation/agent-first-default";

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

  // Computer sidebar state (right side)
  sidebarOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  sidebarContent: SidebarContent | null;
  setSidebarContent: (content: SidebarContent | null) => void;

  // Chat sidebar state (left side)
  chatSidebarOpen: boolean;
  setChatSidebarOpen: (open: boolean) => void;
  optimisticChatId: string | null;
  setOptimisticChatId: (chatId: string | null) => void;

  // Todos state
  todos: Todo[];
  setTodos: (todos: Todo[]) => void;
  mergeTodos: (todos: TodoLike[]) => void;
  replaceAssistantTodos: (todos: Todo[], sourceMessageId?: string) => void;

  // UI state
  isTodoPanelExpanded: boolean;
  setIsTodoPanelExpanded: (expanded: boolean) => void;

  // Subscription state
  subscription: SubscriptionTier;
  isCheckingProPlan: boolean;

  // Rate limit warning dismissal state
  hasUserDismissedRateLimitWarning: boolean;
  setHasUserDismissedRateLimitWarning: (dismissed: boolean) => void;

  // Message queue state (for Agent mode)
  messageQueue: QueuedMessage[];
  queueMessage: (text: string, files?: FileMessagePart[]) => void;
  removeQueuedMessage: (id: string) => void;
  clearQueue: () => void;

  // Queue behavior preference
  queueBehavior: QueueBehavior;
  setQueueBehavior: (behavior: QueueBehavior) => void;

  // Sandbox preference (for Agent mode)
  sandboxPreference: SandboxPreference;
  setSandboxPreference: (preference: SandboxPreference) => void;

  // Desktop bridge active (Centrifugo-based desktop sandbox)
  desktopBridgeActive: boolean;

  // Whether a local sandbox (desktop or remote) is available
  hasLocalSandbox: boolean;

  // Active local sandbox connections, shared to avoid duplicate Convex subscriptions
  localConnections: LocalSandboxConnection[] | undefined;

  // The sandbox preference to use for free agent mode (desktop or first remote connection ID)
  defaultLocalSandboxPreference: SandboxPreference | null;

  // Model selection
  selectedModel: SelectedModel;
  setSelectedModel: (model: SelectedModel) => void;

  // Utility methods
  clearInput: () => void;
  clearUploadedFiles: () => void;
  openSidebar: (content: SidebarContent) => void;
  updateSidebarContent: (updates: Partial<SidebarContent>) => void;
  closeSidebar: () => void;
  toggleChatSidebar: () => void;
  initializeChat: (chatId: string, fromRoute?: boolean) => void;
  initializeNewChat: () => void;

  // Temporary chats preference
  temporaryChatsEnabled: boolean;
  setTemporaryChatsEnabled: (enabled: boolean) => void;

  // Team pricing dialog state
  teamPricingDialogOpen: boolean;
  setTeamPricingDialogOpen: (open: boolean) => void;

  // Team welcome dialog state
  teamWelcomeDialogOpen: boolean;
  setTeamWelcomeDialogOpen: (open: boolean) => void;

  // PentestGPT migration confirm dialog state
  migrateFromPentestgptDialogOpen: boolean;
  setMigrateFromPentestgptDialogOpen: (open: boolean) => void;

  // Register a chat reset function that will be invoked on initializeNewChat
  setChatReset: (fn: (() => void) | null) => void;
}

const GlobalStateContext = createContext<GlobalStateType | undefined>(
  undefined,
);

interface GlobalStateProviderProps {
  children: ReactNode;
}

interface LocalSandboxConnection {
  connectionId: string;
  name: string;
  osInfo?: {
    platform: string;
    arch: string;
    release: string;
    hostname: string;
  };
  lastSeen: number;
  isDesktop: boolean;
  capabilities: {
    commands: boolean;
    pty: boolean;
  };
}

export const GlobalStateProvider: React.FC<GlobalStateProviderProps> = ({
  children,
}) => {
  const {
    user,
    entitlements,
    loading: authLoading,
    organizationId,
    refreshAuth,
  } = useAuth();
  const { refresh: refreshAccessToken } = useAccessToken();
  const isMobile = useIsMobile();
  const prevIsMobile = useRef(isMobile);
  const shownReferralRewardNotificationsRef = useRef(new Set<string>());
  const initialSavedChatModeRef = useRef<ChatMode | null>(null);
  const hasUserSelectedModeThisSessionRef = useRef(false);
  const agentFirstDefaultAppliedRef = useRef(false);
  const [input, setInput] = useState("");
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFileState[]>([]);
  const [chatMode, setChatModeState] = useState<ChatMode>(() => {
    const saved = readChatMode();
    if (!isChatMode(saved)) return "ask";
    initialSavedChatModeRef.current = saved;
    return saved;
  });
  const setChatMode = useCallback((mode: ChatMode) => {
    hasUserSelectedModeThisSessionRef.current = true;
    setChatModeState(mode);
  }, []);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarContent, setSidebarContent] = useState<SidebarContent | null>(
    null,
  );
  const [subscription, setSubscription] = useState<SubscriptionTier>("free");
  const setSubscriptionWithNormalize = useCallback((tier: SubscriptionTier) => {
    setSubscription(tier);
  }, []);
  const [isCheckingProPlan, setIsCheckingProPlan] = useState(false);
  const subscriptionFromEntitlements = useMemo<SubscriptionTier | null>(() => {
    if (!Array.isArray(entitlements)) return null;
    return resolveSubscriptionTier(entitlements);
  }, [entitlements]);
  const refreshAuthTokenAfterEntitlementRefresh = useCallback(async () => {
    clearSharedToken();

    try {
      if (refreshAuth) {
        await refreshAuth(organizationId ? { organizationId } : undefined);
      }
    } catch {
      // Keep going: the access-token refresh below may still pick up the
      // sealed session written by /api/entitlements.
    }

    try {
      const token = await refreshAccessToken();
      if (token) {
        setSharedToken(token);
      }
    } catch {
      // Non-fatal. The UI still reflects /api/entitlements, and AuthKit will
      // retry token refresh through its normal path.
    }
  }, [organizationId, refreshAccessToken, refreshAuth]);

  // Persist chat mode preference to localStorage on change
  useEffect(() => {
    if (
      initialSavedChatModeRef.current === null &&
      !agentFirstDefaultAppliedRef.current &&
      !hasUserSelectedModeThisSessionRef.current
    ) {
      return;
    }

    writeChatMode(chatMode);
  }, [chatMode]);

  useEffect(() => {
    if (user) {
      markHasAuthenticatedBefore();
    }
  }, [user]);

  useEffect(() => {
    if (!user) return;

    fetch("/api/referrals/attribution", {
      method: "POST",
      credentials: "include",
    })
      .then(async (response) => {
        if (!response.ok) return;
        const body = (await response.json().catch(() => null)) as {
          status?: string;
          starterBonusUnitsAwarded?: boolean;
          starterBonusUnits?: number;
        } | null;
        const bonusUnits =
          typeof body?.starterBonusUnits === "number"
            ? body.starterBonusUnits
            : 0;

        if (
          body?.status === "attributed" &&
          body.starterBonusUnitsAwarded &&
          bonusUnits > 0
        ) {
          toast.success("Referral bonus added", {
            description: `You got ${bonusUnits} extra free request${bonusUnits === 1 ? "" : "s"}.`,
          });
        }
      })
      .catch(() => {
        // Referral attribution is best-effort and must never block app startup.
      });
  }, [user]);

  const unreadReferralRewardNotifications = useQuery(
    api.referrals.getUnreadRewardNotifications,
    user ? {} : "skip",
  );
  const markReferralRewardNotificationsSeen = useMutation(
    api.referrals.markRewardNotificationsSeen,
  );

  useEffect(() => {
    if (!user || !unreadReferralRewardNotifications?.length) return;

    const notifications = unreadReferralRewardNotifications.filter(
      (notification) =>
        !shownReferralRewardNotificationsRef.current.has(notification.rewardId),
    );
    if (notifications.length === 0) return;

    for (const notification of notifications) {
      shownReferralRewardNotificationsRef.current.add(notification.rewardId);
    }

    const totalDollars = notifications.reduce(
      (sum, notification) => sum + notification.amountDollars,
      0,
    );
    const amountLabel = new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: Number.isInteger(totalDollars) ? 0 : 2,
    }).format(totalDollars);
    const rewardIds = notifications.map(
      (notification) => notification.rewardId,
    );

    const description =
      subscription === "free"
        ? `You earned ${amountLabel} in usage credits. They apply after you upgrade.`
        : `You earned ${amountLabel} in extra usage credits.`;

    toast.success("Referral reward added", { description });
    void markReferralRewardNotificationsSeen({ rewardIds }).catch(() => {
      // The toast is non-critical; the next app load can retry marking it seen.
    });
  }, [
    markReferralRewardNotificationsSeen,
    subscription,
    unreadReferralRewardNotifications,
    user,
  ]);

  // Initialize chat sidebar state
  const [chatSidebarOpen, setChatSidebarOpen] = useState(() =>
    chatSidebarStorage.get(isMobile ?? false),
  );
  const [optimisticChatId, setOptimisticChatId] = useState<string | null>(null);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [isTodoPanelExpanded, setIsTodoPanelExpanded] = useState(false);
  const mergeTodos = useCallback((newTodos: TodoLike[]) => {
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
  const chatResetRef = useRef<(() => void) | null>(null);
  const desktopEntitlementRefreshUserRef = useRef<string | null>(null);

  // Rate limit warning dismissal state (persists across chat switches)
  const [
    hasUserDismissedRateLimitWarning,
    setHasUserDismissedRateLimitWarning,
  ] = useState(false);

  // Message queue state (for Agent mode queueing)
  const [messageQueue, setMessageQueue] = useState<QueuedMessage[]>([]);

  // Queue behavior preference (persisted to localStorage)
  const [queueBehavior, setQueueBehaviorState] = useState<QueueBehavior>(() => {
    if (typeof window === "undefined") return "queue";
    const saved = localStorage.getItem("queue-behavior");
    if (saved === "queue" || saved === "stop-and-send") {
      return saved;
    }
    return "queue"; // Default: queue after current message completes
  });

  // Tauri detection + sandbox preference (co-located in a custom hook)
  const { sandboxPreference, setSandboxPreference, desktopBridgeActive } =
    useSandboxPreference(!!user);

  // Check for available local sandbox connections
  const localConnections = useQuery(
    api.localSandbox.listConnections,
    user ? undefined : "skip",
  );
  const hasLocalSandbox = useMemo(
    () => desktopBridgeActive || (localConnections?.length ?? 0) > 0,
    [desktopBridgeActive, localConnections],
  );

  const defaultLocalSandboxPreference =
    useMemo<SandboxPreference | null>(() => {
      if (desktopBridgeActive) return "desktop";
      const firstRemote = localConnections?.find((c) => !c.isDesktop);
      if (firstRemote) return firstRemote.connectionId;
      const firstDesktop = localConnections?.find((c) => c.isDesktop);
      if (firstDesktop) return "desktop";
      return null;
    }, [desktopBridgeActive, localConnections]);

  const entitlementRefreshRequested =
    typeof window !== "undefined" &&
    new URL(window.location.href).searchParams.get("refresh") ===
      "entitlements";
  const desktopEntitlementRefreshPending =
    Boolean(user) &&
    !authLoading &&
    subscriptionFromEntitlements === "free" &&
    isTauriEnvironment() &&
    desktopEntitlementRefreshUserRef.current !== user?.id &&
    !entitlementRefreshRequested;
  const subscriptionResolved =
    Boolean(user) &&
    !authLoading &&
    subscriptionFromEntitlements !== null &&
    !entitlementRefreshRequested &&
    !desktopEntitlementRefreshPending;

  // Persist queue behavior to localStorage
  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("queue-behavior", queueBehavior);
    }
  }, [queueBehavior]);

  // Model selection — HackerAI tier ids (Lite/Pro/Max) are mode-agnostic;
  // the active model is resolved server-side via resolveTierToProviderKey.
  const [selectedModel, setSelectedModelRaw] = useState<SelectedModel>(() => {
    const saved = readSelectedModel();
    return saved ?? "auto";
  });

  // Persist model preference to localStorage (single key, shared across modes).
  useEffect(() => {
    writeSelectedModel(selectedModel);
  }, [selectedModel]);

  const setSelectedModelState = useCallback((model: SelectedModel) => {
    setSelectedModelRaw(model);
  }, []);

  // Initialize temporary chats from URL parameter
  const [temporaryChatsEnabled, setTemporaryChatsEnabled] = useState(() => {
    if (typeof window === "undefined") return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("temporary-chat") === "true";
  });

  useEffect(() => {
    if (agentFirstDefaultAppliedRef.current) return;

    const selectedSubscription =
      subscriptionFromEntitlements === null ||
      subscriptionFromEntitlements === "free"
        ? subscription
        : subscriptionFromEntitlements;
    const savedModePresent = initialSavedChatModeRef.current !== null;
    const userSelectedModeThisSession =
      hasUserSelectedModeThisSessionRef.current;
    const agentDefaultDecision = getAgentFirstDefaultDecision({
      chatMode,
      defaultLocalSandboxPreference,
      hasLocalSandbox,
      hasSavedChatMode: savedModePresent,
      hasUserSelectedModeThisSession: userSelectedModeThisSession,
      isCheckingProPlan,
      isMobile,
      subscription: selectedSubscription,
      subscriptionResolved,
      temporaryChatsEnabled,
      userPresent: Boolean(user),
    });

    if (!agentDefaultDecision) {
      return;
    }

    const localSandboxPreference = agentDefaultDecision.useDefaultLocalSandbox
      ? defaultLocalSandboxPreference
      : null;

    if (
      agentDefaultDecision.useDefaultLocalSandbox &&
      !localSandboxPreference
    ) {
      return;
    }

    const appliedSandboxPreference =
      localSandboxPreference ?? sandboxPreference;
    const sandboxType = normalizeAgentFirstSandboxType(
      appliedSandboxPreference ?? null,
    );

    agentFirstDefaultAppliedRef.current = true;
    setChatModeState("agent");
    if (localSandboxPreference) {
      setSandboxPreference(localSandboxPreference);
    }
    if (selectedModel !== "auto") {
      setSelectedModelRaw("auto");
    }

    const now = new Date().toISOString();
    const agentFirstProperties = {
      experiment_key: agentDefaultDecision.experimentKey,
      first_experience_event_version: 2,
      variant: "agent_first",
      subscription: selectedSubscription,
      eligible_subscription_tier: agentDefaultDecision.eligibleSubscriptionTier,
      selected_subscription_tier: selectedSubscription,
      selection_reason: agentDefaultDecision.selectionReason,
      default_applied: true,
      has_local_sandbox: hasLocalSandbox,
      sandbox_type: sandboxType,
      sandbox_preference: sandboxType,
      surface: "new_chat",
      previous_saved_mode: savedModePresent,
      saved_mode_present: savedModePresent,
      user_selected_mode_this_session: userSelectedModeThisSession,
      is_mobile: isMobile === true,
      current_mode_before: chatMode,
      $set_once: {
        first_experience_variant: "agent_first",
        first_experience_exposed_at: now,
      },
    };
    captureAuthenticatedEvent("first_experience_exposed", agentFirstProperties);
    captureAuthenticatedEvent(
      "agent_first_default_applied",
      agentFirstProperties,
    );
  }, [
    chatMode,
    defaultLocalSandboxPreference,
    hasLocalSandbox,
    isCheckingProPlan,
    isMobile,
    sandboxPreference,
    selectedModel,
    setSandboxPreference,
    subscription,
    subscriptionFromEntitlements,
    subscriptionResolved,
    temporaryChatsEnabled,
    user,
  ]);

  // Initialize team pricing dialog from URL hash
  const [teamPricingDialogOpen, setTeamPricingDialogOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.location.hash === "#team-pricing-seat-selection";
  });

  // Initialize team welcome dialog from URL parameter
  const [teamWelcomeDialogOpen, setTeamWelcomeDialogOpen] = useState(() => {
    if (typeof window === "undefined") return false;
    const urlParams = new URLSearchParams(window.location.search);
    return urlParams.get("team-welcome") === "true";
  });

  // Initialize PentestGPT migration confirm dialog from URL parameter
  const [migrateFromPentestgptDialogOpen, setMigrateFromPentestgptDialogOpen] =
    useState(() => {
      if (typeof window === "undefined") return false;
      const urlParams = new URLSearchParams(window.location.search);
      return urlParams.get("confirm-migrate-pentestgpt") === "true";
    });

  useEffect(() => {
    // Save state on desktop
    chatSidebarStorage.save(chatSidebarOpen, isMobile ?? false);

    // Close sidebar when transitioning from desktop to mobile
    if (!prevIsMobile.current && isMobile && chatSidebarOpen) {
      setChatSidebarOpen(false);
    }

    prevIsMobile.current = isMobile;
  }, [chatSidebarOpen, isMobile]);

  // Cleanup expired drafts on app initialization (once per session)
  useEffect(() => {
    cleanupExpiredDrafts();
  }, []); // Empty dependency array = runs once on mount

  // Derive subscription tier from current token entitlements
  // When user is still loading, set subscription without normalizing chatMode (avoids resetting mode before auth resolves)
  useEffect(() => {
    if (!user) {
      setSubscription("free");
      desktopEntitlementRefreshUserRef.current = null;
      return;
    }

    if (subscriptionFromEntitlements) {
      setSubscriptionWithNormalize(subscriptionFromEntitlements);
    }
  }, [user, subscriptionFromEntitlements, setSubscriptionWithNormalize]);

  // Desktop sessions are created through a separate OAuth transfer flow. Older
  // desktop sessions may be unscoped, so refresh once to pull WorkOS
  // entitlements from the user's organization before showing them as free.
  useEffect(() => {
    const refreshDesktopEntitlements = async () => {
      if (!user || typeof window === "undefined" || !isTauriEnvironment()) {
        return;
      }

      const currentEntitlements = Array.isArray(entitlements)
        ? entitlements
        : [];
      if (resolveSubscriptionTier(currentEntitlements) !== "free") {
        return;
      }

      const url = new URL(window.location.href);
      if (url.searchParams.get("refresh") === "entitlements") {
        return;
      }

      if (desktopEntitlementRefreshUserRef.current === user.id) {
        return;
      }
      desktopEntitlementRefreshUserRef.current = user.id;

      setIsCheckingProPlan(true);
      try {
        const response = await fetch("/api/entitlements", {
          credentials: "include",
        });
        if (!response.ok) return;

        const data = await response.json();
        await refreshAuthTokenAfterEntitlementRefresh();
        setSubscriptionWithNormalize(
          resolveSubscriptionTier(
            Array.isArray(data.entitlements) ? data.entitlements : [],
          ),
        );
      } catch {
        // Keep the token-derived tier; this is only a best-effort desktop heal.
      } finally {
        setIsCheckingProPlan(false);
      }
    };

    refreshDesktopEntitlements();
  }, [
    user,
    entitlements,
    refreshAuthTokenAfterEntitlementRefresh,
    setSubscriptionWithNormalize,
  ]);

  // Refresh entitlements only when explicitly requested via URL param
  useEffect(() => {
    const refreshFromUrl = async () => {
      if (!user) {
        setSubscriptionWithNormalize("free");
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
          await refreshAuthTokenAfterEntitlementRefresh();
          const tier = data.subscription as SubscriptionTier | undefined;
          setSubscription(
            tier === "ultra" ||
              tier === "team" ||
              tier === "pro-plus" ||
              tier === "pro"
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
          setSubscriptionWithNormalize("free");
        }
      } catch {
        setSubscriptionWithNormalize("free");
      } finally {
        setIsCheckingProPlan(false);
        // Remove the refresh param to avoid repeated refreshes
        url.searchParams.delete("refresh");
        window.history.replaceState({}, "", url.toString());
      }
    };

    refreshFromUrl();
  }, [
    user,
    refreshAuthTokenAfterEntitlementRefresh,
    setSubscriptionWithNormalize,
  ]);

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

  // Listen for URL changes to sync team welcome dialog state
  useEffect(() => {
    const handleUrlChange = () => {
      if (typeof window === "undefined") return;
      const urlParams = new URLSearchParams(window.location.search);
      const shouldOpen = urlParams.get("team-welcome") === "true";

      // Only update state if it differs to avoid infinite loops
      if (teamWelcomeDialogOpen !== shouldOpen) {
        setTeamWelcomeDialogOpen(shouldOpen);
      }
    };

    // Listen for popstate events (browser back/forward)
    window.addEventListener("popstate", handleUrlChange);

    return () => {
      window.removeEventListener("popstate", handleUrlChange);
    };
  }, [teamWelcomeDialogOpen]);

  // Listen for URL changes to sync PentestGPT migration confirm dialog state
  useEffect(() => {
    const handleUrlChange = () => {
      if (typeof window === "undefined") return;
      const urlParams = new URLSearchParams(window.location.search);
      const shouldOpen = urlParams.get("confirm-migrate-pentestgpt") === "true";

      if (migrateFromPentestgptDialogOpen !== shouldOpen) {
        setMigrateFromPentestgptDialogOpen(shouldOpen);
      }
    };

    window.addEventListener("popstate", handleUrlChange);

    return () => {
      window.removeEventListener("popstate", handleUrlChange);
    };
  }, [migrateFromPentestgptDialogOpen]);

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

  // Check if any files are currently uploading or have errors
  const isUploadingFiles = uploadedFiles.some(
    (file) => file.uploading || file.error,
  );

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

  // Message queue handlers
  const queueMessage = useCallback(
    (text: string, files?: FileMessagePart[]) => {
      setMessageQueue((prev) => {
        // Limit queue size to 10 messages
        if (prev.length >= 10) {
          toast.error("Queue is full", {
            description:
              "Please wait for queued messages to send before adding more.",
          });
          return prev;
        }

        const newMessage: QueuedMessage = {
          id: uuidv4(),
          text,
          files,
          timestamp: Date.now(),
        };
        return [...prev, newMessage];
      });
    },
    [],
  );

  const removeQueuedMessage = useCallback((id: string) => {
    setMessageQueue((prev) => prev.filter((msg) => msg.id !== id));
  }, []);

  const clearQueue = useCallback(() => {
    setMessageQueue([]);
  }, []);

  const initializeChat = useCallback((chatId: string, _fromRoute?: boolean) => {
    // Don't clear input here - let ChatInput restore draft automatically
    // setInput("");  // Removed - ChatInput will handle draft restoration
    setTodos([]);
    setIsTodoPanelExpanded(false);
    // Navigating to an existing chat means we're no longer in temporary chat mode
    setTemporaryChatsEnabled(false);
  }, []);

  const initializeNewChat = useCallback(() => {
    // Allow chat component to reset its local state immediately
    if (chatResetRef.current) {
      chatResetRef.current();
    }
    setTodos([]);
    setIsTodoPanelExpanded(false);
  }, []);

  const setChatReset = useCallback((fn: (() => void) | null) => {
    chatResetRef.current = fn;
  }, []);

  const openSidebar = (content: SidebarContent) => {
    setSidebarContent(content);
    setSidebarOpen(true);
  };

  const updateSidebarContent = (updates: Partial<SidebarContent>) => {
    setSidebarContent((current) => {
      if (current) {
        return { ...current, ...updates } as SidebarContent;
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

  // Custom setter for team welcome dialog that also updates URL
  const setTeamWelcomeDialogOpenWithUrl = useCallback((open: boolean) => {
    setTeamWelcomeDialogOpen(open);

    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (!open) {
        // Remove the param when dialog is closed
        url.searchParams.delete("team-welcome");
        window.history.replaceState({}, "", url.toString());
      }
    }
  }, []);

  // Custom setter for PentestGPT migration confirm dialog that also updates URL
  const setMigrateFromPentestgptDialogOpenWithUrl = useCallback(
    (open: boolean) => {
      setMigrateFromPentestgptDialogOpen(open);

      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (open) {
          url.searchParams.set("confirm-migrate-pentestgpt", "true");
        } else {
          url.searchParams.delete("confirm-migrate-pentestgpt");
        }
        window.history.replaceState({}, "", url.toString());
      }
    },
    [],
  );

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
    sidebarOpen,
    setSidebarOpen,
    sidebarContent,
    setSidebarContent,
    chatSidebarOpen,
    setChatSidebarOpen,
    optimisticChatId,
    setOptimisticChatId,
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

    temporaryChatsEnabled,
    setTemporaryChatsEnabled: setTemporaryChatsEnabledWithUrl,

    teamPricingDialogOpen,
    setTeamPricingDialogOpen,

    teamWelcomeDialogOpen,
    setTeamWelcomeDialogOpen: setTeamWelcomeDialogOpenWithUrl,

    migrateFromPentestgptDialogOpen,
    setMigrateFromPentestgptDialogOpen:
      setMigrateFromPentestgptDialogOpenWithUrl,

    setChatReset,

    hasUserDismissedRateLimitWarning,
    setHasUserDismissedRateLimitWarning,

    messageQueue,
    queueMessage,
    removeQueuedMessage,
    clearQueue,

    queueBehavior,
    setQueueBehavior: setQueueBehaviorState,

    sandboxPreference,
    setSandboxPreference,
    desktopBridgeActive,
    hasLocalSandbox,
    localConnections,
    defaultLocalSandboxPreference,

    selectedModel,
    setSelectedModel: setSelectedModelState,
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
