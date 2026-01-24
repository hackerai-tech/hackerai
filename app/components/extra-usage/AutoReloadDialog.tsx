"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";

type AutoReloadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (thresholdDollars: number, amountDollars: number) => Promise<void>;
  onTurnOff: () => Promise<void>;
  onCancel: () => void;
  isLoading: boolean;
  isEnabled: boolean;
  currentThresholdDollars: number | null;
  currentAmountDollars: number | null;
};

type ContentProps = Omit<AutoReloadDialogProps, "open" | "onOpenChange">;

const AutoReloadDialogContent = ({
  onSave,
  onTurnOff,
  onCancel,
  isLoading,
  isEnabled,
  currentThresholdDollars,
  currentAmountDollars,
}: ContentProps) => {
  // Initialize state directly from props - component remounts when dialog opens
  const [threshold, setThreshold] = useState(
    currentThresholdDollars ? String(currentThresholdDollars) : "5",
  );
  const [amount, setAmount] = useState(
    currentAmountDollars ? String(currentAmountDollars) : "15",
  );

  const handleSubmit = async () => {
    const thresholdDollars = parseFloat(threshold);
    const amountDollars = parseFloat(amount);

    if (isNaN(thresholdDollars) || isNaN(amountDollars)) {
      return;
    }

    await onSave(thresholdDollars, amountDollars);
  };

  const handleTurnOff = async () => {
    await onTurnOff();
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isEnabled ? "Auto-reload settings" : "Turn on auto-reload"}
        </DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-6 py-4">
        <DialogDescription>
          Automatically buy more extra usage when your balance is low.
        </DialogDescription>
        <div className="space-y-4">
          <div>
            <Label htmlFor="auto-reload-threshold" className="mb-2 block">
              When extra usage balance is:
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                $
              </span>
              <Input
                id="auto-reload-threshold"
                type="number"
                min="1"
                step="1"
                placeholder="5"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                className="pl-7"
              />
            </div>
          </div>
          <div>
            <Label htmlFor="auto-reload-amount" className="mb-2 block">
              Reload balance to:
            </Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                $
              </span>
              <Input
                id="auto-reload-amount"
                type="number"
                min="5"
                step="5"
                placeholder="15"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="pl-7"
              />
            </div>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          You agree that HackerAI will charge the card you have on file in the
          amount above on a recurring basis whenever your balance reaches the
          amount indicated. To cancel, turn off auto-reload.
        </p>
      </div>
      <DialogFooter className="flex flex-col gap-2 sm:flex-row sm:justify-end">
        {isEnabled ? (
          <>
            <Button
              variant="outline"
              onClick={handleTurnOff}
              disabled={isLoading}
            >
              Turn off
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? "Saving..." : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel} disabled={isLoading}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading}>
              {isLoading ? "Turning on..." : "Turn on"}
            </Button>
          </>
        )}
      </DialogFooter>
    </>
  );
};

const AutoReloadDialog = ({
  open,
  onOpenChange,
  onSave,
  onTurnOff,
  onCancel,
  isLoading,
  isEnabled,
  currentThresholdDollars,
  currentAmountDollars,
}: AutoReloadDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <AutoReloadDialogContent
            onSave={onSave}
            onTurnOff={onTurnOff}
            onCancel={onCancel}
            isLoading={isLoading}
            isEnabled={isEnabled}
            currentThresholdDollars={currentThresholdDollars}
            currentAmountDollars={currentAmountDollars}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export { AutoReloadDialog };
