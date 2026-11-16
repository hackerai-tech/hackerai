"use client";

import {
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Infinity as InfinityIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import type { FreeAgentActivationStatus } from "@/lib/activation/free-agent-activation";
import {
  captureFreeAgentGateShown,
  captureFreeAgentSetupAction,
} from "@/app/hooks/useFreeAgentActivation";
import { AgentUpgradeDialog } from "./AgentUpgradeDialog";

const SURFACE = "chat_input_free_agent_gate";

// A background tab has not shown the gate; record it once it is on screen.
const subscribePageVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const getPageVisible = () => document.visibilityState !== "hidden";
const getServerPageVisible = () => false;

export interface FreeAgentGateNoticeProps {
  status: FreeAgentActivationStatus;
  /** True until a computer is selected; the card is the only way forward. */
  needsComputer: boolean;
  connectedComputerName: string | null;
}

/**
 * Persistent choice shown after the introductory Ask replies are used. It also
 * owns the setup dialog so setup can finish after the card itself disappears.
 */
export function FreeAgentGateNotice({
  status,
  needsComputer,
  connectedComputerName,
}: FreeAgentGateNoticeProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const titleId = useId();
  const shownRef = useRef(false);
  const pageVisible = useSyncExternalStore(
    subscribePageVisibility,
    getPageVisible,
    getServerPageVisible,
  );

  useEffect(() => {
    if (!needsComputer || !pageVisible || shownRef.current) return;
    shownRef.current = captureFreeAgentGateShown(status, SURFACE);
  }, [needsComputer, pageVisible, status]);

  return (
    <>
      {needsComputer && (
        <section
          aria-labelledby={titleId}
          className="mb-2 flex flex-col gap-3 rounded-xl border bg-card px-4 py-3.5 text-sm sm:flex-row sm:items-center sm:gap-4"
          data-testid="free-agent-gate-notice"
        >
          <div className="flex min-w-0 flex-1 items-start gap-3 sm:items-center">
            <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-background">
              <InfinityIcon className="size-4" aria-hidden="true" />
            </div>
            <div className="min-w-0 space-y-0.5">
              <h2 id={titleId} className="text-sm font-medium">
                You&apos;ve used your {status.introLimit} free Ask replies
              </h2>
              <p className="text-[13px] leading-[18px] text-muted-foreground">
                Use Agent free on your own computer, or upgrade for Cloud Agent.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                captureFreeAgentSetupAction(status, "upgrade", SURFACE);
                redirectToPricing({
                  surface: SURFACE,
                  source: "free_agent_activation_gate",
                  from_tier: "free",
                  cta_text: "Upgrade",
                });
              }}
            >
              Upgrade
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                captureFreeAgentSetupAction(status, "open_setup", SURFACE);
                setSetupOpen(true);
              }}
            >
              Continue with Agent
            </Button>
          </div>
        </section>
      )}
      <AgentUpgradeDialog
        open={setupOpen}
        onOpenChange={setSetupOpen}
        isDesktopEnvironment={false}
        desktopBridgeStatus="idle"
        onRetryDesktopBridge={() => {}}
        onUseConnectedDesktop={() => setSetupOpen(false)}
        activation={{ status, connectedComputerName }}
      />
    </>
  );
}
