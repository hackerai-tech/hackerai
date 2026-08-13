"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";

type AgentAutoReviewAvailabilityContextType = {
  agentAutoReviewAvailable: boolean | null;
  resolveAgentAutoReviewAvailability: () => void;
};

const AgentAutoReviewAvailabilityContext =
  createContext<AgentAutoReviewAvailabilityContextType | null>(null);

export function AgentAutoReviewAvailabilityProvider({
  children,
}: {
  children: ReactNode;
}) {
  const { user } = useAuth();
  const authUserId = user?.id;
  const [availability, setAvailability] = useState<{
    userId: string;
    available: boolean;
  } | null>(null);
  const requestRef = useRef<{
    userId: string;
    request: Promise<boolean>;
  } | null>(null);

  const agentAutoReviewAvailable =
    availability && availability.userId === authUserId
      ? availability.available
      : null;

  const resolveAgentAutoReviewAvailability = useCallback(() => {
    if (
      !authUserId ||
      availability?.userId === authUserId ||
      requestRef.current?.userId === authUserId
    ) {
      return;
    }

    const request = fetch("/api/experiments/agent-auto-review", {
      credentials: "same-origin",
      cache: "no-store",
    })
      .then(async (response) => {
        if (!response.ok) return false;
        const data = (await response.json()) as { available?: unknown };
        return data.available === true;
      })
      .catch(() => false);

    requestRef.current = { userId: authUserId, request };
    void request.then((available) => {
      const activeRequest = requestRef.current;
      if (
        activeRequest?.userId !== authUserId ||
        activeRequest.request !== request
      ) {
        return;
      }

      requestRef.current = null;
      setAvailability({ userId: authUserId, available });
    });
  }, [authUserId, availability?.userId]);

  const value = useMemo(
    () => ({
      agentAutoReviewAvailable,
      resolveAgentAutoReviewAvailability,
    }),
    [agentAutoReviewAvailable, resolveAgentAutoReviewAvailability],
  );

  return (
    <AgentAutoReviewAvailabilityContext.Provider value={value}>
      {children}
    </AgentAutoReviewAvailabilityContext.Provider>
  );
}

export function useAgentAutoReviewAvailability() {
  const context = useContext(AgentAutoReviewAvailabilityContext);
  if (!context) {
    throw new Error(
      "useAgentAutoReviewAvailability must be used within an AgentAutoReviewAvailabilityProvider",
    );
  }

  return context;
}
