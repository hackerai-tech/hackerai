"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export interface AgentUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onUpgradeClick: () => void;
}

export function AgentUpgradeDialog({
  open,
  onOpenChange,
  onUpgradeClick,
}: AgentUpgradeDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[500px]"
        data-testid="agent-upgrade-dialog"
      >
        <DialogHeader>
          <DialogTitle>Upgrade plan</DialogTitle>
          <DialogDescription>
            Get access to Agent mode and unlock advanced hacking, testing, and
            security features with Pro.
          </DialogDescription>
        </DialogHeader>
        <Button
          onClick={onUpgradeClick}
          className="w-full"
          size="lg"
          data-testid="agent-upgrade-button"
        >
          Upgrade plan
        </Button>
      </DialogContent>
    </Dialog>
  );
}
