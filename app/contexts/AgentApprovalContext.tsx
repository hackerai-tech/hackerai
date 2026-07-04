"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { sendTriggerSessionInput } from "@/lib/chat/trigger-browser-realtime";
import type {
  AgentToolApprovalDecision,
  AgentToolApprovalInputRecord,
} from "@/types";

export type AgentApprovalSendState = "idle" | "sending" | "approved" | "denied";

export type AgentApprovalSession = {
  chatId?: string;
  sessionId: string;
  publicAccessToken: string;
};

export type ActiveAgentToolApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  title: string;
  target?: string;
  detail?: string;
};

type SendAgentToolApprovalArgs = {
  approvalId: string;
  toolCallId: string;
  decision: AgentToolApprovalDecision;
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
  sendToolApproval: (args: SendAgentToolApprovalArgs) => Promise<void>;
};

const AgentApprovalContext = createContext<AgentApprovalContextValue | null>(
  null,
);

export function AgentApprovalProvider({ children }: { children: ReactNode }) {
  const [session, setAgentApprovalSession] =
    useState<AgentApprovalSession | null>(null);
  const [activeToolApprovalRequest, setActiveToolApprovalRequest] =
    useState<ActiveAgentToolApprovalRequest | null>(null);
  const [toolApprovalSendStates, setToolApprovalSendStates] = useState<
    Record<string, AgentApprovalSendState>
  >({});

  const clearAgentApprovalSession = useCallback(() => {
    setAgentApprovalSession(null);
    setActiveToolApprovalRequest(null);
    setToolApprovalSendStates({});
  }, []);

  const clearActiveToolApprovalRequest = useCallback(
    ({
      approvalId,
      toolCallId,
    }: {
      approvalId?: string;
      toolCallId?: string;
    }) => {
      setActiveToolApprovalRequest((current) => {
        if (!current) return null;
        if (approvalId && current.approvalId !== approvalId) return current;
        if (toolCallId && current.toolCallId !== toolCallId) return current;
        return null;
      });
    },
    [],
  );

  const sendToolApproval = useCallback(
    async ({ approvalId, toolCallId, decision }: SendAgentToolApprovalArgs) => {
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
        grant: "full_access",
        at: Date.now(),
      };

      setToolApprovalSendStates((states) => ({
        ...states,
        [approvalId]: "sending",
      }));

      try {
        await sendTriggerSessionInput({
          sessionId: session.sessionId,
          accessToken: session.publicAccessToken,
          partId: `agent-tool-approval:${approvalId}:${decision}`,
          value: record,
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
      sendToolApproval,
    }),
    [
      activeToolApprovalRequest,
      clearActiveToolApprovalRequest,
      clearAgentApprovalSession,
      sendToolApproval,
      session,
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
