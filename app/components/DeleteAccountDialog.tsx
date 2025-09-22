"use client";

import React, { useMemo, useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Lock, TriangleAlert } from "lucide-react";

type DeleteAccountDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export const DeleteAccountDialog = ({
  open,
  onOpenChange,
}: DeleteAccountDialogProps) => {
  const { user } = useAuth();
  const deleteAllUserData = useMutation(api.userDeletion.deleteAllUserData);
  const [isDeleting, setIsDeleting] = useState(false);
  const [emailInput, setEmailInput] = useState("");
  const [confirmInput, setConfirmInput] = useState("");

  const lastSignInAtIso: string | null = useMemo(() => {
    if (!user) return null;
    // WorkOS user has lastSignInAt ISO string when available
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const value = (user as any)?.lastSignInAt as string | undefined;
    return value ?? null;
  }, [user]);

  const hasRecentLogin = useMemo(() => {
    if (!lastSignInAtIso) return false;
    const last = new Date(lastSignInAtIso).getTime();
    if (Number.isNaN(last)) return false;
    const tenMinutesMs = 10 * 60 * 1000;
    return Date.now() - last <= tenMinutesMs;
  }, [lastSignInAtIso]);

  const expectedEmail: string = useMemo(() => user?.email ?? "", [user]);

  const canDelete = useMemo(() => {
    if (!hasRecentLogin) return false;
    const emailMatches =
      emailInput.trim().toLowerCase() === expectedEmail.toLowerCase();
    const phraseMatches = confirmInput.trim() === "DELETE";
    return emailMatches && phraseMatches && !isDeleting;
  }, [confirmInput, emailInput, expectedEmail, hasRecentLogin, isDeleting]);

  const handleRefreshLogin = async () => {
    const { clientLogout } = await import("@/lib/utils/logout");
    clientLogout();
  };

  const handleConfirmDelete = async () => {
    if (isDeleting || !canDelete) return;
    setIsDeleting(true);
    try {
      // 1) Delete all Convex data first
      await deleteAllUserData({});
      // 2) Cancel Stripe subs, remove WorkOS org(s), and delete WorkOS user server-side
      const res = await fetch("/api/delete-account", { method: "POST" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to cancel subscriptions");
      }
      // 3) Clear HttpOnly auth cookies on the server, then redirect home
      try {
        await fetch("/api/clear-auth-cookies", { method: "POST" });
      } catch {}
      try {
        sessionStorage.clear();
        localStorage.clear();
      } catch {}
      window.location.replace("/");
    } catch (error) {
      console.error("Failed to delete user data:", error);
      toast.error(
        "Failed to delete account. Please try again or contact support.",
      );
      setIsDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange} modal={true}>
      <DialogContent className="sm:max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Delete account - are you sure?</DialogTitle>
        </DialogHeader>
        <div className="text-sm">
          <p>
            Deleting your account will remove all your data, including chats,
            settings, and personal information. This action cannot be undone.
          </p>

          {!hasRecentLogin && (
            <DialogDescription className="text-xs pt-4">
              You may only delete your account if you have logged in within the
              last 10 minutes. Please log in again, then return here to
              continue.
            </DialogDescription>
          )}
        </div>

        {hasRecentLogin && (
          <div className="pt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="delete-email">
                Please type your account email.
              </Label>
              <Input
                id="delete-email"
                type="email"
                inputMode="email"
                aria-label="Account email"
                placeholder={expectedEmail || "name@example.com"}
                value={emailInput}
                onChange={(e) => setEmailInput(e.target.value)}
                aria-invalid={
                  Boolean(emailInput) &&
                  emailInput.trim().toLowerCase() !==
                    expectedEmail.toLowerCase()
                }
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="delete-confirm">
                To proceed, type &quot;DELETE&quot; in the input field below.
              </Label>
              <Input
                id="delete-confirm"
                aria-label="Type DELETE to confirm"
                placeholder="DELETE"
                value={confirmInput}
                onChange={(e) => setConfirmInput(e.target.value)}
                aria-invalid={
                  Boolean(confirmInput) && confirmInput.trim() !== "DELETE"
                }
              />
            </div>
          </div>
        )}

        <DialogFooter>
          {!hasRecentLogin ? (
            <Button onClick={handleRefreshLogin} className="w-full">
              Refresh login
            </Button>
          ) : canDelete && !isDeleting ? (
            <Button
              variant="destructive"
              onClick={handleConfirmDelete}
              className="w-full"
            >
              <TriangleAlert aria-hidden="true" className="size-4" />
              Permanently delete my account
            </Button>
          ) : (
            <div
              role="status"
              aria-live="polite"
              className="w-full h-10 rounded-md border border-input bg-input/30 dark:bg-input/30 text-muted-foreground flex items-center justify-center gap-2"
            >
              <Lock aria-hidden="true" className="size-4" />
              <span>{isDeleting ? "Deleting..." : "Locked"}</span>
            </div>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default DeleteAccountDialog;
