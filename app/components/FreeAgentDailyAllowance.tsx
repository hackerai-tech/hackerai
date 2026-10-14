"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { Button } from "@/components/ui/button";
import {
  FREE_AGENT_COMPLETED_DAILY_EXPOSURE,
  freeAgentDailyExposureProperties,
  type FreeAgentDailyStatus,
} from "@/lib/experiments/free-agent-completed-daily";

export function FreeAgentDailyAllowance({
  children,
  running,
}: {
  children: (blocked: boolean) => ReactNode;
  running: boolean;
}) {
  const { user } = useAuth();
  const { subscription, isCheckingProPlan, chatMode, setChatMode } =
    useGlobalState();
  const userId = user?.id;
  const eligible =
    !!userId &&
    subscription === "free" &&
    !isCheckingProPlan &&
    chatMode === "agent" &&
    !running;
  const [result, setResult] = useState<{
    userId: string;
    status: FreeAgentDailyStatus | null;
  }>();
  const captured = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!eligible || !userId) return;
    let active = true;
    let controller: AbortController | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reset: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      controller?.abort();
      clearTimeout(timeout);
      clearTimeout(reset);
      const request = new AbortController();
      controller = request;
      timeout = setTimeout(() => request.abort(), 5_000);
      void fetch("/api/experiments/free-agent-completed-daily", {
        cache: "no-store",
        signal: request.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error("Allowance unavailable");
          const { status } = await response.json();
          const valid =
            status &&
            ["control", "test"].includes(status.assignment?.variant) &&
            typeof status.completed === "boolean" &&
            Number.isFinite(status.resetTimestamp) &&
            status.resetTimestamp > Date.now();
          if (!active || controller !== request) return;
          setResult({ userId, status: valid ? status : null });
          if (valid)
            reset = setTimeout(
              refresh,
              Math.min(status.resetTimestamp - Date.now() + 100, 86_400_000),
            );
        })
        .catch(() => {
          if (active && controller === request)
            setResult({ userId, status: null });
        })
        .finally(() => {
          if (controller === request) clearTimeout(timeout);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      controller?.abort();
      clearTimeout(timeout);
      clearTimeout(reset);
      window.removeEventListener("focus", refresh);
    };
  }, [eligible, userId]);

  const status = eligible && result?.userId === userId ? result.status : null;
  useEffect(() => {
    if (!status || !userId) return;
    const key = `${userId}:${status.assignment.variant}`;
    if (captured.current === key) return;
    if (
      captureAuthenticatedEvent(
        FREE_AGENT_COMPLETED_DAILY_EXPOSURE,
        freeAgentDailyExposureProperties(status.assignment, "composer"),
      )
    )
      captured.current = key;
  }, [status, userId]);

  if (!status || status.assignment.variant === "control")
    return children(false);
  const resetLabel = new Date(status.resetTimestamp).toLocaleString(undefined, {
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return (
    <>
      {children(status.completed)}
      <div
        role="status"
        className="mx-auto mt-2 flex max-w-3xl flex-wrap items-center gap-2 px-4 text-sm text-muted-foreground"
        data-testid="free-agent-daily-allowance"
      >
        <p className="min-w-0 w-full sm:w-auto sm:flex-1">
          {status.completed
            ? `You've used today's free Agent allowance. Resets ${resetLabel}.`
            : "Free Agent includes one completed response per day, within your existing usage limits. Failed starts don't use this allowance."}
        </p>
        {status.completed && (
          <Button
            size="sm"
            variant="outline"
            onClick={() => setChatMode("ask")}
          >
            Use Ask
          </Button>
        )}
        <Button
          size="sm"
          variant={status.completed ? "default" : "ghost"}
          onClick={() =>
            redirectToPricing({
              source: "free_agent_daily_allowance",
              surface: "composer",
              from_tier: "free",
              reason: "free_agent_daily_completed",
            })
          }
        >
          Upgrade
        </Button>
      </div>
    </>
  );
}
