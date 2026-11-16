"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
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
  /**
   * "attached" tucks the tab behind the composer's top edge, like the attached
   * goal panel. "detached" stands alone when other panels join the composer.
   */
  placement?: "attached" | "detached";
}

/**
 * Persistent choice shown after the introductory Ask replies are used. It also
 * owns the setup dialog so setup can finish after the tab itself disappears.
 */
export function FreeAgentGateNotice({
  status,
  needsComputer,
  connectedComputerName,
  placement = "detached",
}: FreeAgentGateNoticeProps) {
  const [setupOpen, setSetupOpen] = useState(false);
  const shownRef = useRef(false);
  const attached = placement === "attached";
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
          aria-label={`You've used your ${status.introLimit} free Ask replies`}
          className={`relative z-0 flex min-w-0 shrink-0 items-center gap-3 border border-black/8 bg-muted py-2 pr-2 pl-4 text-[13px] leading-[18px] dark:border-border ${attached ? "mx-3 -mb-5 rounded-t-[22px] border-b-0 pb-7" : "mb-2 rounded-[22px]"}`}
          data-testid="free-agent-gate-notice"
          data-placement={placement}
        >
          <Terminal
            className="hidden size-4 shrink-0 text-muted-foreground sm:block"
            aria-hidden="true"
          />
          <p className="min-w-0 flex-1 truncate sm:whitespace-normal">
            <span className="sm:hidden">
              {status.introLimit} free Ask replies used
            </span>
            <span className="hidden sm:inline">
              You&apos;ve used your {status.introLimit} free Ask replies.{" "}
              <span className="text-muted-foreground">
                Agent runs on your computer.
              </span>
            </span>
          </p>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 rounded-lg px-3 text-[13px]"
            onClick={() => {
              captureFreeAgentSetupAction(status, "open_setup", SURFACE);
              setSetupOpen(true);
            }}
          >
            Continue with Agent
          </Button>
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
