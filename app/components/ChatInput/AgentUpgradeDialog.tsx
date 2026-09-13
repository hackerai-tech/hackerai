"use client";

import { useEffect, useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Check,
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

export interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isDesktopEnvironment: boolean;
  desktopBridgeStatus: DesktopBridgeStatus;
  onRetryDesktopBridge: () => void;
  onUseConnectedDesktop: () => void;
}

export function AgentUpgradeDialog({
  open,
  onOpenChange,
  isDesktopEnvironment,
  desktopBridgeStatus,
  onRetryDesktopBridge,
  onUseConnectedDesktop,
}: AgentUpgradeDialogProps) {
  const capturedImpressionRef = useRef(false);

  useEffect(() => {
    if (!open || capturedImpressionRef.current) return;

    capturedImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "agent_upgrade_dialog",
      source: "agent_mode_gate",
      from_tier: "free",
      cta_text: "Upgrade for cloud Agent",
    });
  }, [open]);

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
