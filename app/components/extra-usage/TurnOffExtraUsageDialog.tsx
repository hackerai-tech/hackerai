"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type TurnOffExtraUsageDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<void>;
  isLoading: boolean;
};

const TurnOffExtraUsageDialog = ({
  open,
  onOpenChange,
  onConfirm,
  isLoading,
}: TurnOffExtraUsageDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Turn off extra usage?</DialogTitle>
        </DialogHeader>
        <DialogDescription className="text-muted-foreground py-4">
          Turning off extra usage will immediately prevent you from using
          HackerAI beyond your base subscription limits. Any ongoing
          conversations may be interrupted.
        </DialogDescription>
        <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isLoading}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={isLoading}
          >
            {isLoading ? "Turning off..." : "Turn off"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export { TurnOffExtraUsageDialog };
