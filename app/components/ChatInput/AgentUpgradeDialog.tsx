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
  RefreshCw,
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
          className="gap-0 rounded-xl sm:max-w-[420px]"
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

const DESKTOP_PLATFORM_NAMES = {
  macos: "macOS",
  windows: "Windows",
  linux: "Linux",
} as const;

/** Quiet secondary choice: a plain row, not a card. */
function SetupRow({
  label,
  hint,
  onClick,
  testId,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex h-10 items-center gap-3 rounded-md px-2 text-left text-sm transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:outline-none"
      data-testid={testId}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span className="hidden shrink-0 text-[13px] text-muted-foreground sm:inline">
        {hint}
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
    </button>
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
    ? `Download HackerAI Desktop for ${directDownload.displayName}`
    : "Download HackerAI Desktop";
  const otherPlatforms = directDownload
    ? Object.entries(DESKTOP_PLATFORM_NAMES)
        .filter(([platform]) => platform !== directDownload.platform)
        .map(([, name]) => name)
    : [];
  const track = (action: FreeAgentSetupAction) =>
    captureFreeAgentSetupAction(status, action, ACTIVATION_SURFACE);

  if (connectedComputerName) {
    return (
      <>
        <DialogHeader className="pr-6 text-left">
          <DialogTitle>Your computer is connected</DialogTitle>
          <DialogDescription className="sr-only">
            Agent will run on {connectedComputerName}.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 items-center gap-2.5 pt-4 pb-6 text-sm">
          <span
            className="size-2 shrink-0 rounded-full bg-emerald-500 dark:bg-emerald-400"
            aria-hidden="true"
          />
          <span className="min-w-0 truncate font-mono">
            {connectedComputerName}
          </span>
        </div>
        <Button
          className="h-10 w-full"
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
        <DialogHeader className="pr-6 text-left">
          <DialogTitle>Finish setup in HackerAI Desktop</DialogTitle>
          <DialogDescription className="sr-only">
            Install HackerAI Desktop and sign in with this account to connect
            it.
          </DialogDescription>
        </DialogHeader>
        <ol className="space-y-3.5 pt-5 pb-5">
          {DESKTOP_SETUP_STEPS.map((text, index) => (
            <li key={text} className="flex items-baseline gap-3 text-sm">
              <span
                className="w-4 shrink-0 font-mono text-[13px] text-muted-foreground"
                aria-hidden="true"
              >
                {index + 1}
              </span>
              {text}
            </li>
          ))}
        </ol>
        <div
          role="status"
          className="flex items-center gap-2.5 border-t pt-4 text-sm text-foreground/80"
        >
          <LoaderCircle
            className="size-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
            aria-hidden="true"
          />
          Waiting for HackerAI Desktop to connect…
        </div>
        <div className="-mx-2 flex items-center justify-between gap-2 pt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={() => setStep("choose")}
          >
            <ChevronLeft aria-hidden="true" />
            Other options
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            asChild
          >
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
      <DialogHeader className="pr-6 text-left">
        <DialogTitle>Continue with Agent</DialogTitle>
        <DialogDescription>
          Agent runs terminal commands and works with files on the computer you
          connect.
        </DialogDescription>
      </DialogHeader>

      <div className="flex flex-col gap-2.5 pt-6 pb-5">
        <Button asChild className="h-10 w-full">
          <a
            href={downloadHref}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              track("download_desktop");
              setStep("waiting");
            }}
            aria-label={downloadLabel}
            data-testid="free-agent-download-desktop"
          >
            <Download aria-hidden="true" />
            {directDownload ? (
              // Narrow widths drop the product name so the OS stays readable.
              <span className="truncate">
                Download{" "}
                <span className="hidden sm:inline">HackerAI Desktop </span>
                for {directDownload.displayName}
              </span>
            ) : (
              <span className="truncate">{downloadLabel}</span>
            )}
          </a>
        </Button>
        {otherPlatforms.length > 0 && (
          <p className="text-center text-[13px] text-muted-foreground">
            Also for{" "}
            <a
              href="/download"
              target="_blank"
              rel="noopener noreferrer"
              className="text-foreground/80 underline decoration-muted-foreground/50 underline-offset-2 hover:text-foreground"
            >
              {otherPlatforms.join(" and ")}
            </a>
          </p>
        )}
      </div>

      <div className="flex flex-col border-t pt-2">
        <SetupRow
          label="Connect an existing computer"
          hint="Run one command"
          testId="free-agent-connect-existing"
          onClick={() => {
            track("connect_existing");
            onClose();
            openSettingsDialog("Remote Control");
          }}
        />
        <SetupRow
          label="Upgrade for Cloud Agent"
          hint="Paid plans"
          testId="free-agent-upgrade"
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
        />
      </div>
    </>
  );
}
