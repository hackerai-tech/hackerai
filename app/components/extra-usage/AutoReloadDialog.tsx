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
    currentThresholdDollars ? String(Math.floor(currentThresholdDollars)) : "5",
  );
  const [amount, setAmount] = useState(
    currentAmountDollars ? String(Math.floor(currentAmountDollars)) : "15",
  );

  const thresholdDollars = parseInt(threshold, 10);
  const amountDollars = parseInt(amount, 10);
  const isThresholdValid = !isNaN(thresholdDollars) && thresholdDollars >= 5;
  const isAmountAtLeast15 = !isNaN(amountDollars) && amountDollars >= 15;
  const isAmountAtLeast10MoreThanThreshold =
    !isNaN(amountDollars) &&
    !isNaN(thresholdDollars) &&
    amountDollars >= thresholdDollars + 10;
  const isAmountValid = isAmountAtLeast15 && isAmountAtLeast10MoreThanThreshold;
  const showThresholdError = threshold !== "" && !isThresholdValid;
  const showAmountMinError = amount !== "" && !isAmountAtLeast15;
  const showAmountGapError =
    amount !== "" &&
    isAmountAtLeast15 &&
    isThresholdValid &&
    !isAmountAtLeast10MoreThanThreshold;

  const handleSubmit = async () => {
    if (!isThresholdValid || !isAmountValid) {
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
                type="text"
                placeholder="5"
                value={threshold}
                onChange={(e) => {
                  // Only allow digits (whole dollars only)
                  const val = e.target.value.replace(/[^0-9]/g, "");
                  setThreshold(val);
                }}
                className="pl-7"
              />
            </div>
            {showThresholdError && (
              <p className="text-sm text-red-500 mt-2">
                Threshold must be at least $5
              </p>
            )}
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
                type="text"
                placeholder="15"
                value={amount}
                onChange={(e) => {
                  // Only allow digits (whole dollars only)
                  const val = e.target.value.replace(/[^0-9]/g, "");
                  setAmount(val);
                }}
                className="pl-7"
              />
            </div>
            {showAmountMinError && (
              <p className="text-sm text-red-500 mt-2">
                Reload amount must be at least $15
              </p>
            )}
            {showAmountGapError && (
              <p className="text-sm text-red-500 mt-2">
                Reload amount must be at least $10 more than the threshold
              </p>
            )}
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
            <Button
              onClick={handleSubmit}
              disabled={isLoading || !isThresholdValid || !isAmountValid}
            >
              {isLoading ? "Saving..." : "Save"}
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onCancel} disabled={isLoading}>
              Cancel
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isLoading || !isThresholdValid || !isAmountValid}
            >
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
