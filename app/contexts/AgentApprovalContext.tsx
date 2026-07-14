"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { sendAgentApprovalSessionInput } from "@/lib/chat/agent-approval-session";
import type {
  AgentToolApprovalDecision,
  AgentToolApprovalGrant,
  AgentToolApprovalGrantKind,
  AgentToolApprovalInputRecord,
  AgentToolApprovalPromptRequest,
} from "@/types";

export type AgentApprovalSendState = "idle" | "sending" | "approved" | "denied";

export type AgentApprovalSession = {
  chatId?: string;
  sessionId: string;
  publicAccessToken: string;
};

export type ActiveAgentToolApprovalRequest = AgentToolApprovalPromptRequest;

const APPROVAL_PROMPT_HANDOFF_DELAY_MS = 500;

type SendAgentToolApprovalArgs = {
  approvalId: string;
  toolCallId: string;
  decision: AgentToolApprovalDecision;
  grant?: AgentToolApprovalGrant;
  targetPrefix?: string;
  targetKind?: AgentToolApprovalGrantKind;
  message?: string;
};

type AgentApprovalContextValue = {
  session: AgentApprovalSession | null;
  activeToolApprovalRequest: ActiveAgentToolApprovalRequest | null;
  toolApprovalSendStates: Record<string, AgentApprovalSendState>;
  setAgentApprovalSession: (session: AgentApprovalSession | null) => void;
  clearAgentApprovalSession: () => void;
  setActiveToolApprovalRequest: (
    request: ActiveAgentToolApprovalRequest | null,
  ) => void;
  clearActiveToolApprovalRequest: (request: {
    approvalId?: string;
    toolCallId?: string;
  }) => void;
  settleActiveToolApprovalRequest: (request: {
    approvalId: string;
    toolCallId: string;
  }) => void;
  sendToolApproval: (args: SendAgentToolApprovalArgs) => Promise<void>;
};

const AgentApprovalContext = createContext<AgentApprovalContextValue | null>(
  null,
);

export function AgentApprovalProvider({ children }: { children: ReactNode }) {
  const [session, setAgentApprovalSession] =
    useState<AgentApprovalSession | null>(null);
  const [activeToolApprovalRequest, setActiveToolApprovalRequestState] =
    useState<ActiveAgentToolApprovalRequest | null>(null);
  const [toolApprovalSendStates, setToolApprovalSendStates] = useState<
    Record<string, AgentApprovalSendState>
  >({});
  const pendingApprovalClearRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const cancelPendingApprovalClear = useCallback(() => {
    if (pendingApprovalClearRef.current === null) return;
    clearTimeout(pendingApprovalClearRef.current);
    pendingApprovalClearRef.current = null;
  }, []);

  useEffect(
    () => () => cancelPendingApprovalClear(),
    [cancelPendingApprovalClear],
  );

  const setActiveToolApprovalRequest = useCallback(
    (request: ActiveAgentToolApprovalRequest | null) => {
      cancelPendingApprovalClear();
      setActiveToolApprovalRequestState(request);
    },
    [cancelPendingApprovalClear],
  );

  const clearAgentApprovalSession = useCallback(() => {
    cancelPendingApprovalClear();
    setAgentApprovalSession(null);
    setActiveToolApprovalRequestState(null);
    setToolApprovalSendStates({});
  }, [cancelPendingApprovalClear]);

  const clearActiveToolApprovalRequest = useCallback(
    ({
      approvalId,
      toolCallId,
    }: {
      approvalId?: string;
      toolCallId?: string;
    }) => {
      cancelPendingApprovalClear();
      setActiveToolApprovalRequestState((current) => {
        if (!current) return null;
        if (approvalId && current.approvalId !== approvalId) return current;
        if (toolCallId && current.toolCallId !== toolCallId) return current;
        return null;
      });
    },
    [cancelPendingApprovalClear],
  );

  const settleActiveToolApprovalRequest = useCallback(
    ({
      approvalId,
      toolCallId,
    }: {
      approvalId: string;
      toolCallId: string;
    }) => {
      cancelPendingApprovalClear();
      pendingApprovalClearRef.current = setTimeout(() => {
        pendingApprovalClearRef.current = null;
        setActiveToolApprovalRequestState((current) => {
          if (
            current?.approvalId !== approvalId ||
            current.toolCallId !== toolCallId
          ) {
            return current;
          }
          return null;
        });
      }, APPROVAL_PROMPT_HANDOFF_DELAY_MS);
    },
    [cancelPendingApprovalClear],
  );

  const sendToolApproval = useCallback(
    async ({
      approvalId,
      toolCallId,
      decision,
      grant = "full_access",
      targetPrefix,
      targetKind,
      message,
    }: SendAgentToolApprovalArgs) => {
      if (!session) {
        throw new Error("No active Agent approval session.");
      }
      const currentState = toolApprovalSendStates[approvalId];
      if (
        currentState === "sending" ||
        currentState === "approved" ||
        currentState === "denied"
      ) {
        return;
      }

      const record: AgentToolApprovalInputRecord = {
        type: "agent-tool-approval",
        approvalId,
        toolCallId,
        decision,
        grant,
        ...(targetPrefix ? { targetPrefix } : {}),
        ...(targetKind ? { targetKind } : {}),
        ...(message ? { message } : {}),
        at: Date.now(),
      };

      setToolApprovalSendStates((states) => ({
        ...states,
        [approvalId]: "sending",
      }));

      try {
        await sendAgentApprovalSessionInput({
          chatId: session.chatId,
          sessionId: session.sessionId,
          accessToken: session.publicAccessToken,
          partId: `agent-tool-approval:${approvalId}:${decision}:${grant}`,
          value: record,
          onAccessTokenRefreshed: (publicAccessToken) => {
            setAgentApprovalSession((currentSession) =>
              currentSession?.sessionId === session.sessionId &&
              currentSession.chatId === session.chatId
                ? { ...currentSession, publicAccessToken }
                : currentSession,
            );
          },
        });
        setToolApprovalSendStates((states) => ({
          ...states,
          [approvalId]: decision === "approve" ? "approved" : "denied",
        }));
      } catch (error) {
        setToolApprovalSendStates((states) => ({
          ...states,
          [approvalId]: "idle",
        }));
        throw error;
      }
    },
    [session, toolApprovalSendStates],
  );

  const value = useMemo<AgentApprovalContextValue>(
    () => ({
      session,
      activeToolApprovalRequest,
      toolApprovalSendStates,
      setAgentApprovalSession,
      clearAgentApprovalSession,
      setActiveToolApprovalRequest,
      clearActiveToolApprovalRequest,
      settleActiveToolApprovalRequest,
      sendToolApproval,
    }),
    [
      activeToolApprovalRequest,
      clearActiveToolApprovalRequest,
      clearAgentApprovalSession,
      sendToolApproval,
      session,
      setActiveToolApprovalRequest,
      settleActiveToolApprovalRequest,
      toolApprovalSendStates,
    ],
  );

  return (
    <AgentApprovalContext.Provider value={value}>
      {children}
    </AgentApprovalContext.Provider>
  );
}

export function useAgentApproval() {
  const context = useContext(AgentApprovalContext);
  if (!context) {
    throw new Error(
      "useAgentApproval must be used within an AgentApprovalProvider",
    );
  }
  return context;
}
