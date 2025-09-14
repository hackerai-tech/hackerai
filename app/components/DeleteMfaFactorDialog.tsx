"use client";

import React, { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface DeleteMfaFactorDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  factorId: string | null;
  onDeleted: () => void;
}

const DeleteMfaFactorDialog: React.FC<DeleteMfaFactorDialogProps> = ({
  open,
  onOpenChange,
  factorId,
  onDeleted,
}) => {
  const [code, setCode] = useState("");
  const [removing, setRemoving] = useState(false);

  const handleClose = () => {
    setCode("");
    onOpenChange(false);
  };

  const handleRemove = async () => {
    if (!factorId) return;
    if (!code || code.trim().length !== 6) {
      toast.error("Enter a valid 6-digit code");
      return;
    }
    setRemoving(true);
    try {
      const response = await fetch("/api/mfa/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ factorId, code: code.trim() }),
      });

      if (response.ok) {
        toast.success("Authentication method removed successfully");
        handleClose();
        onDeleted();
        return;
      }

      const err = await response.json().catch(() => ({}));
      toast.error(err?.error || "Failed to remove authentication method");
      if (response.status === 401) {
        window.location.href = "/logout";
      }
    } catch {
      toast.error("Failed to remove authentication method");
    } finally {
      setRemoving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md max-w-[95vw]">
        <DialogTitle>Remove authentication method</DialogTitle>
        <DialogDescription>
          To remove this method, confirm with a 6-digit code from your
          authenticator app.
        </DialogDescription>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="delete-mfa-code">Enter your one-time code*</Label>
            <Input
              id="delete-mfa-code"
              type="text"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              maxLength={6}
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={handleClose} disabled={removing}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing || code.length !== 6}
              className="bg-red-600 hover:bg-red-700 text-white"
            >
              {removing ? "Removing..." : "Remove"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};

export { DeleteMfaFactorDialog };
