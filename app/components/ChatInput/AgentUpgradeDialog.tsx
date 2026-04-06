"use client";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Download, Laptop, Cloud } from "lucide-react";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";

export interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AgentUpgradeDialog({
  open,
  onOpenChange,
}: AgentUpgradeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px]"
        data-testid="agent-upgrade-dialog"
      >
        <DialogHeader>
          <DialogTitle>Get Agent mode</DialogTitle>
          <DialogDescription>
            Connect a local sandbox to use Agent mode for free.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3 pt-1">
          {/* Local sandbox options */}
          <div className="rounded-lg border p-1 space-y-1">
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
                  Download and run locally
                </div>
              </div>
            </button>
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
                  Connect via the CLI package
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
              redirectToPricing();
            }}
            className="w-full flex items-center gap-3 p-3 rounded-lg border text-left hover:bg-muted/50 transition-colors"
            data-testid="agent-upgrade-button"
          >
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary/10">
              <Cloud className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">Upgrade to Pro</div>
              <div className="text-xs text-muted-foreground">
                Cloud sandbox, custom models, higher limits
              </div>
            </div>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
