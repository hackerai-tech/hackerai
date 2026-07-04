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

export type AgentApprovalSession = {
  chatId?: string;
  sessionId: string;
  publicAccessToken: string;
};

type SendAgentToolApprovalArgs = {
  approvalId: string;
  toolCallId: string;
  decision: AgentToolApprovalDecision;
};

type AgentApprovalContextValue = {
  session: AgentApprovalSession | null;
  setAgentApprovalSession: (session: AgentApprovalSession | null) => void;
  clearAgentApprovalSession: () => void;
  sendToolApproval: (args: SendAgentToolApprovalArgs) => Promise<void>;
};

const AgentApprovalContext = createContext<AgentApprovalContextValue | null>(
  null,
);

export function AgentApprovalProvider({ children }: { children: ReactNode }) {
  const [session, setAgentApprovalSession] =
    useState<AgentApprovalSession | null>(null);

  const clearAgentApprovalSession = useCallback(() => {
    setAgentApprovalSession(null);
  }, []);

  const sendToolApproval = useCallback(
    async ({ approvalId, toolCallId, decision }: SendAgentToolApprovalArgs) => {
      if (!session) {
        throw new Error("No active Agent approval session.");
      }

      const record: AgentToolApprovalInputRecord = {
        type: "agent-tool-approval",
        approvalId,
        toolCallId,
        decision,
        grant: "full_access",
        at: Date.now(),
      };

      await sendTriggerSessionInput({
        sessionId: session.sessionId,
        accessToken: session.publicAccessToken,
        partId: `agent-tool-approval:${approvalId}:${decision}`,
        value: record,
      });
    },
    [session],
  );

  const value = useMemo<AgentApprovalContextValue>(
    () => ({
      session,
      setAgentApprovalSession,
      clearAgentApprovalSession,
      sendToolApproval,
    }),
    [clearAgentApprovalSession, sendToolApproval, session],
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
