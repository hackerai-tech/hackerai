"use client";

import { useEffect, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Download,
  Laptop,
  LoaderCircle,
  Monitor,
  RefreshCw,
  SquareTerminal,
} from "lucide-react";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { captureUpgradeCtaImpression } from "@/lib/analytics/client";
import type { DesktopBridgeStatus } from "@/app/hooks/useSandboxPreference";
import { useDetectedPlatform } from "@/app/download/DownloadSection";
import type { FreeAgentActivationStatus } from "@/lib/activation/free-agent-activation";
import {
  captureFreeAgentSetupAction,
  type FreeAgentSetupAction,
} from "@/app/hooks/useFreeAgentActivation";

const ACTIVATION_SURFACE = "free_agent_activation_dialog";
const ACTIVATION_SOURCE = "free_agent_activation_gate";

export interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktopEnvironment: boolean;
  desktopBridgeStatus: DesktopBridgeStatus;
  onRetryDesktopBridge: () => void;
  onUseConnectedDesktop: () => void;
  /** Setup opened from the free Agent activation gate (HAC-246). */
  activation?: {
    status: FreeAgentActivationStatus | null;
    /** Name of the computer Agent will use, once one is connected. */
    connectedComputerName: string | null;
  };
}

export function AgentUpgradeDialog({
  open,
  onOpenChange,
  isDesktopEnvironment,
  desktopBridgeStatus,
  onRetryDesktopBridge,
  onUseConnectedDesktop,
  activation,
}: AgentUpgradeDialogProps) {
  const capturedImpressionRef = useRef(false);
  const isActivation = activation !== undefined;

  useEffect(() => {
    if (!open || capturedImpressionRef.current) return;

    capturedImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: isActivation ? ACTIVATION_SURFACE : "agent_upgrade_dialog",
      source: isActivation ? ACTIVATION_SOURCE : "agent_mode_gate",
      from_tier: "free",
      cta_text: "Upgrade for cloud Agent",
    });
  }, [isActivation, open]);

  if (activation) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-[460px]"
          data-testid="agent-upgrade-dialog"
        >
          <ActivationSetup
            status={activation.status}
            connectedComputerName={activation.connectedComputerName}
            onClose={() => onOpenChange(false)}
          />
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px]"
        data-testid="agent-upgrade-dialog"
      >
        <DialogHeader>
          <DialogTitle>Use Agent mode</DialogTitle>
          <DialogDescription>
            {isDesktopEnvironment
              ? desktopBridgeStatus === "failed"
                ? "HackerAI Desktop is open, but its local sandbox could not connect."
                : desktopBridgeStatus === "connected"
                  ? "HackerAI Desktop is connected and ready for local Agent mode."
                  : "HackerAI Desktop is connecting its local sandbox."
              : "Connect a local sandbox for free, or upgrade for cloud Agent mode with higher limits."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-1">
          {/* Local sandbox options */}
          <div className="rounded-lg border p-1 space-y-1">
            {isDesktopEnvironment ? (
              desktopBridgeStatus === "failed" ? (
                <button
                  onClick={onRetryDesktopBridge}
                  className="w-full flex items-center gap-3 p-3 rounded-md text-left hover:bg-muted/50 transition-colors"
                  data-testid="agent-retry-desktop-button"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <RefreshCw className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      Retry Desktop connection
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Reconnect the local sandbox
                    </div>
                  </div>
                </button>
              ) : desktopBridgeStatus === "connected" ? (
                <button
                  onClick={onUseConnectedDesktop}
                  className="w-full flex items-center gap-3 p-3 rounded-md text-left hover:bg-muted/50 transition-colors"
                  data-testid="agent-use-desktop-button"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <Check className="h-4 w-4" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">Use Agent mode</div>
                    <div className="text-xs text-muted-foreground">
                      Run with the Desktop sandbox
                    </div>
                  </div>
                </button>
              ) : (
                <div
                  className="w-full flex items-center gap-3 p-3 rounded-md text-left"
                  role="status"
                  data-testid="agent-desktop-connecting"
                >
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                    <LoaderCircle className="h-4 w-4 animate-spin" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">
                      Connecting Desktop sandbox
                    </div>
                    <div className="text-xs text-muted-foreground">
                      This usually takes a few seconds
                    </div>
                  </div>
                </div>
              )
            ) : (
              <button
                onClick={() => {
                  onOpenChange(false);
                  window.open("/download", "_blank");
                }}
                className="w-full flex items-center gap-3 p-3 rounded-md text-left hover:bg-muted/50 transition-colors"
                data-testid="agent-install-desktop-button"
              >
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                  <Download className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">Desktop App</div>
                  <div className="text-xs text-muted-foreground">
                    Free local Agent runs
                  </div>
                </div>
              </button>
            )}
            <button
              onClick={() => {
                onOpenChange(false);
                openSettingsDialog("Remote Control");
              }}
              className="w-full flex items-center gap-3 p-3 rounded-md text-left hover:bg-muted/50 transition-colors"
              data-testid="agent-connect-remote-button"
            >
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background">
                <Laptop className="h-4 w-4" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">Remote Machine</div>
                <div className="text-xs text-muted-foreground">
                  Free Agent on your own machine
                </div>
              </div>
            </button>
          </div>

          {/* Separator with upgrade path */}
          <div className="relative">
            <div className="absolute inset-0 flex items-center">
              <span className="w-full border-t" />
            </div>
            <div className="relative flex justify-center text-xs uppercase">
              <span className="bg-background px-2 text-muted-foreground">
                or
              </span>
            </div>
          </div>

          <button
            onClick={() => {
              onOpenChange(false);
              redirectToPricing({
                surface: "agent_upgrade_dialog",
                source: "agent_mode_gate",
                from_tier: "free",
                cta_text: "Upgrade for cloud Agent",
              });
            }}
            className="w-full flex items-center gap-3 p-3 rounded-lg border text-left hover:bg-muted/50 transition-colors"
            data-testid="agent-upgrade-button"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md">
              <Cloud className="h-4 w-4 text-white" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Upgrade for cloud Agent</div>
              <div className="text-xs text-muted-foreground">
                No local setup, stronger models, higher limits
              </div>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

const DESKTOP_SETUP_STEPS = [
  "Open the downloaded installer",
  "Sign in with the same HackerAI account",
  "Keep the app open while it connects",
];

function SetupIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border bg-background [&_svg]:size-4">
      {children}
    </div>
  );
}

function ActivationSetup({
  status,
  connectedComputerName,
  onClose,
}: {
  status: FreeAgentActivationStatus | null;
  connectedComputerName: string | null;
  onClose: () => void;
}) {
  const [step, setStep] = useState<"choose" | "waiting">("choose");
  const detected = useDetectedPlatform();
  const directDownload =
    detected &&
    (detected.platform === "macos" ||
      detected.platform === "windows" ||
      detected.platform === "linux") &&
    detected.downloadUrl
      ? detected
      : null;
  const downloadHref = directDownload?.downloadUrl || "/download";
  const downloadLabel = directDownload
    ? `Download for ${directDownload.displayName}`
    : "Download HackerAI Desktop";
  const track = (action: FreeAgentSetupAction) =>
    captureFreeAgentSetupAction(status, action, ACTIVATION_SURFACE);

  if (connectedComputerName) {
    return (
      <>
        <DialogHeader>
          <DialogTitle>{connectedComputerName} is connected</DialogTitle>
          <DialogDescription className="sr-only">
            Agent will run on this computer.
          </DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-3 rounded-lg border p-3">
          <SetupIcon>
            <Check className="text-emerald-600 dark:text-emerald-400" />
          </SetupIcon>
          <div className="min-w-0 flex-1 truncate text-sm font-medium">
            {connectedComputerName}
          </div>
        </div>
        <Button
          className="w-full"
          onClick={() => {
            track("use_connected");
            onClose();
          }}
          data-testid="free-agent-use-connected"
        >
          Use Agent
        </Button>
      </>
    );
  }

  if (step === "waiting") {
    return (
      <>
        <DialogHeader>
          <DialogTitle>Set up HackerAI Desktop</DialogTitle>
          <DialogDescription className="sr-only">
            Install HackerAI Desktop and sign in with this account to connect
            it.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3">
          {DESKTOP_SETUP_STEPS.map((text, index) => (
            <li key={text} className="flex items-center gap-3 text-sm">
              <span className="flex size-6 shrink-0 items-center justify-center rounded-full border text-xs font-medium">
                {index + 1}
              </span>
              {text}
            </li>
          ))}
        </ol>
        <div
          role="status"
          className="flex items-center gap-2.5 rounded-lg bg-muted px-3 py-3 text-sm text-muted-foreground"
        >
          <LoaderCircle
            className="size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Waiting for HackerAI Desktop to connect…
        </div>
        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setStep("choose")}
          >
            <ChevronLeft aria-hidden="true" />
            Other options
          </Button>
          <Button variant="ghost" size="sm" asChild>
            <a
              href={downloadHref}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => track("download_again")}
            >
              Download again
            </a>
          </Button>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Continue with Agent</DialogTitle>
        <DialogDescription>
          Agent runs terminal commands and works with files on the computer you
          connect.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-3 pt-1">
        <div className="space-y-1 rounded-lg border p-1">
          <div className="space-y-3 rounded-md bg-muted/60 p-3">
            <div className="flex items-center gap-3">
              <SetupIcon>
                <Monitor />
              </SetupIcon>
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium" translate="no">
                  HackerAI Desktop
                </div>
                <div className="text-xs text-muted-foreground">
                  Free · macOS, Windows and Linux
                </div>
              </div>
            </div>
            <Button asChild className="w-full">
              <a
                href={downloadHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  track("download_desktop");
                  setStep("waiting");
                }}
                data-testid="free-agent-download-desktop"
              >
                <Download aria-hidden="true" />
                {downloadLabel}
              </a>
            </Button>
          </div>
          <button
            type="button"
            onClick={() => {
              track("connect_existing");
              onClose();
              openSettingsDialog("Remote Control");
            }}
            className="flex w-full items-center gap-3 rounded-md p-3 text-left transition-colors hover:bg-muted/50"
            data-testid="free-agent-connect-existing"
          >
            <SetupIcon>
              <SquareTerminal />
            </SetupIcon>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium">
                Connect an existing computer
              </div>
              <div className="text-xs text-muted-foreground">
                Run one connect command in its terminal
              </div>
            </div>
            <ChevronRight
              className="size-4 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
          </button>
        </div>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-background px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <button
          type="button"
          onClick={() => {
            track("upgrade");
            onClose();
            redirectToPricing({
              surface: ACTIVATION_SURFACE,
              source: ACTIVATION_SOURCE,
              from_tier: "free",
              cta_text: "Upgrade for Cloud Agent",
            });
          }}
          className="flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left transition-colors hover:bg-muted/50"
          data-testid="free-agent-upgrade"
        >
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-premium-bg text-premium-text">
            <Cloud className="size-4" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">Upgrade for Cloud Agent</div>
            <div className="text-xs text-muted-foreground">
              No setup, stronger models, higher limits
            </div>
          </div>
          <ChevronRight
            className="size-4 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        </button>
      </div>
    </>
  );
}
