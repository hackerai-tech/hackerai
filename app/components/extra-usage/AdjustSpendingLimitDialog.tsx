"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type AdjustSpendingLimitDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (limitDollars: number | null) => Promise<void>;
  isLoading: boolean;
  currentLimitDollars: number | null;
};

type ContentProps = Omit<
  AdjustSpendingLimitDialogProps,
  "open" | "onOpenChange"
>;

const AdjustSpendingLimitDialogContent = ({
  onSave,
  isLoading,
  currentLimitDollars,
}: ContentProps) => {
  // Initialize state directly from props - component remounts when dialog opens
  const [inputValue, setInputValue] = useState<string>(
    currentLimitDollars === null ? "20" : String(currentLimitDollars),
  );

  const handleSetLimit = async () => {
    const limit = parseFloat(inputValue);
    if (isNaN(limit) || limit < 0) return;
    await onSave(limit);
  };

  const handleSetUnlimited = async () => {
    await onSave(null);
  };

  const parsedLimit = parseFloat(inputValue);
  const isValidLimit = !isNaN(parsedLimit) && parsedLimit >= 0;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Set monthly spending limit</DialogTitle>
      </DialogHeader>
      <div className="flex flex-col gap-6 pt-4">
        <p className="text-sm text-foreground">
          You can set a maximum amount you can spend on extra usage per month.
        </p>
        <div>
          <Input
            type="text"
            value={`$${inputValue}`}
            onChange={(e) => {
              const val = e.target.value.replace(/[^0-9.]/g, "");
              setInputValue(val);
            }}
            className="w-full"
            aria-label="Monthly spending limit"
          />
          <p className="text-xs mt-3 text-muted-foreground">
            This spending limit goes into effect immediately
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            onClick={handleSetUnlimited}
            disabled={isLoading}
          >
            {isLoading ? "Saving..." : "Set to unlimited"}
          </Button>
          <Button
            onClick={handleSetLimit}
            disabled={isLoading || !isValidLimit}
          >
            {isLoading ? "Saving..." : "Set spending limit"}
          </Button>
        </div>
      </div>
    </>
  );
};

const AdjustSpendingLimitDialog = ({
  open,
  onOpenChange,
  onSave,
  isLoading,
  currentLimitDollars,
}: AdjustSpendingLimitDialogProps) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {open && (
          <AdjustSpendingLimitDialogContent
            onSave={onSave}
            isLoading={isLoading}
            currentLimitDollars={currentLimitDollars}
          />
        )}
      </DialogContent>
    </Dialog>
  );
};

export { AdjustSpendingLimitDialog };
