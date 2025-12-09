"use client";

import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, Plus, Minus } from "lucide-react";

interface TeamMember {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  createdAt: string;
  isCurrentUser: boolean;
}

interface PendingInvitation {
  id: string;
  email: string;
  role: string;
  invitedAt: string;
  expiresAt: string;
}

interface TeamDialogsProps {
  // Invite dialog props
  showInviteDialog: boolean;
  setShowInviteDialog: (show: boolean) => void;
  inviteEmail: string;
  setInviteEmail: (email: string) => void;
  inviting: boolean;
  handleInvite: (e: React.FormEvent) => void;

  // Remove member dialog props
  memberToRemove: TeamMember | null;
  setMemberToRemove: (member: TeamMember | null) => void;
  removing: string | null;
  handleRemove: () => void;

  // Revoke invitation dialog props
  inviteToRevoke: PendingInvitation | null;
  setInviteToRevoke: (invitation: PendingInvitation | null) => void;
  revokingInvite: string | null;
  handleRevokeInvite: () => void;

  // Leave team dialog props
  showLeaveDialog: boolean;
  setShowLeaveDialog: (show: boolean) => void;
  leaving: boolean;
  handleLeaveTeam: () => void;
}

export const TeamDialogs = ({
  showInviteDialog,
  setShowInviteDialog,
  inviteEmail,
  setInviteEmail,
  inviting,
  handleInvite,
  memberToRemove,
  setMemberToRemove,
  removing,
  handleRemove,
  inviteToRevoke,
  setInviteToRevoke,
  revokingInvite,
  handleRevokeInvite,
  showLeaveDialog,
  setShowLeaveDialog,
  leaving,
  handleLeaveTeam,
}: TeamDialogsProps) => {
  return (
    <>
      {/* Invite Member Dialog */}
      <Dialog
        open={showInviteDialog}
        onOpenChange={(open) => {
          setShowInviteDialog(open);
          if (!open) {
            setInviteEmail("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Invite team member</DialogTitle>
            <DialogDescription>
              Send an invitation to join your team. If they already have an
              account, they&apos;ll need to log out and log back in after
              accepting the invite to access the team subscription.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleInvite}>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email address
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder="colleague@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  disabled={inviting}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setShowInviteDialog(false);
                  setInviteEmail("");
                }}
                disabled={inviting}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={inviting}>
                {inviting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin mr-2" />
                    Sending...
                  </>
                ) : (
                  "Send invitation"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Remove Member Confirmation Dialog */}
      <Dialog
        open={!!memberToRemove}
        onOpenChange={(open) => !open && setMemberToRemove(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove team member</DialogTitle>
            <DialogDescription>
              Are you sure you want to remove{" "}
              <span className="font-medium text-foreground">
                {memberToRemove?.email}
              </span>{" "}
              from your team? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMemberToRemove(null)}
              disabled={removing === memberToRemove?.id}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRemove}
              disabled={removing === memberToRemove?.id}
            >
              {removing === memberToRemove?.id ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Removing...
                </>
              ) : (
                "Remove member"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Revoke Invitation Confirmation Dialog */}
      <Dialog
        open={!!inviteToRevoke}
        onOpenChange={(open) => !open && setInviteToRevoke(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke invitation</DialogTitle>
            <DialogDescription>
              Are you sure you want to revoke the invitation for{" "}
              <span className="font-medium text-foreground">
                {inviteToRevoke?.email}
              </span>
              ? They will no longer be able to join your team using this
              invitation.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setInviteToRevoke(null)}
              disabled={revokingInvite === inviteToRevoke?.id}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleRevokeInvite}
              disabled={revokingInvite === inviteToRevoke?.id}
            >
              {revokingInvite === inviteToRevoke?.id ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Revoking...
                </>
              ) : (
                "Revoke invitation"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decrease Seats Dialog - Removed, now using ManageSeatsDialog in TeamTab */}

      {/* Leave Team Dialog */}
      <Dialog
        open={showLeaveDialog}
        onOpenChange={(open) => !open && setShowLeaveDialog(false)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Leave team</DialogTitle>
            <DialogDescription>
              Are you sure you want to leave this team? You will lose access to
              all team plan features and will need to be re-invited to join
              again.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowLeaveDialog(false)}
              disabled={leaving}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleLeaveTeam}
              disabled={leaving}
            >
              {leaving ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Leaving...
                </>
              ) : (
                "Leave team"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export const TeamWelcomeDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Welcome to Team Plan! 🎉</DialogTitle>
          <DialogDescription>
            Thanks for subscribing to the Team plan! You can now add members to
            your team through Settings → Team tab.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export const InviteAcceptedDialog = ({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) => {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Welcome to the team! 🎉</DialogTitle>
          <DialogDescription>
            You&apos;ve successfully joined the team. You now have access to all
            team plan features.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface SeatPreview {
  currentQuantity: number;
  newQuantity: number;
  seatsDelta: number;
  proratedCharge: number;
  proratedCredit: number;
  totalDue: number;
  pricePerSeat: number;
  proratedPerSeat: number;
  paymentMethod: string;
  currentPeriodEnd: number;
  nextInvoiceAmount: number;
  isIncrease: boolean;
  isYearly: boolean;
  totalUsed: number;
}

const formatUnixDate = (ts?: number) =>
  typeof ts === "number" && Number.isFinite(ts) && ts > 0
    ? new Date(ts * 1000).toLocaleDateString()
    : "";

export const ManageSeatsDialog = ({
  open,
  onOpenChange,
  currentSeats,
  totalUsedSeats,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentSeats: number;
  totalUsedSeats: number;
  onSuccess: () => void;
}) => {
  const [targetSeats, setTargetSeats] = useState(currentSeats);
  const [preview, setPreview] = useState<SeatPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");

  const seatsDelta = targetSeats - currentSeats;
  const isIncrease = seatsDelta > 0;
  const isDecrease = seatsDelta < 0;
  const maxSeats = 999;
  const minSeats = Math.max(2, totalUsedSeats);

  // Fetch preview when dialog opens or targetSeats changes
  useEffect(() => {
    if (!open || targetSeats === currentSeats) {
      setPreview(null);
      return;
    }

    const fetchPreview = async () => {
      setLoadingPreview(true);
      setError("");
      try {
        const res = await fetch("/api/team/seats", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ quantity: targetSeats }),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Failed to fetch preview");
        }

        const data = await res.json();
        setPreview(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load preview");
        setPreview(null);
      } finally {
        setLoadingPreview(false);
      }
    };

    const debounce = setTimeout(fetchPreview, 300);
    return () => clearTimeout(debounce);
  }, [open, targetSeats, currentSeats]);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setTargetSeats(currentSeats);
      setError("");
      setPreview(null);
    }
  }, [open, currentSeats]);

  const handleConfirm = async () => {
    setConfirming(true);
    setError("");

    try {
      const res = await fetch("/api/team/seats", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quantity: targetSeats }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error || "Failed to update seats");
      }

      if (data.success) {
        onOpenChange(false);
        onSuccess();
      } else if (data.requiresPayment && data.invoiceUrl) {
        window.location.href = data.invoiceUrl;
      } else {
        throw new Error(data.message || "Failed to update seats");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update seats");
    } finally {
      setConfirming(false);
    }
  };

  const getButtonText = () => {
    if (confirming) return null;
    if (!preview || seatsDelta === 0) return "Select seat count";

    if (isIncrease) {
      return `Add ${seatsDelta} seat${seatsDelta > 1 ? "s" : ""} for $${preview.totalDue.toFixed(2)}`;
    } else {
      return `Remove ${Math.abs(seatsDelta)} seat${Math.abs(seatsDelta) > 1 ? "s" : ""} (+$${preview.proratedCredit.toFixed(2)} credit)`;
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>Manage seats</DialogTitle>
          <DialogDescription>
            Adjust the number of seats for your team. Adding seats charges a
            prorated amount; removing seats applies a credit to your account.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Seat Selector */}
          <div className="space-y-2">
            <label className="text-sm font-medium">Number of seats</label>
            <div className="flex items-center gap-3">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  setTargetSeats(Math.max(minSeats, targetSeats - 1))
                }
                disabled={targetSeats <= minSeats || confirming}
              >
                <Minus className="h-4 w-4" />
              </Button>
              <Input
                type="number"
                min={minSeats}
                max={maxSeats}
                value={targetSeats}
                onChange={(e) => {
                  const val = parseInt(e.target.value) || currentSeats;
                  setTargetSeats(Math.min(maxSeats, Math.max(minSeats, val)));
                }}
                className="w-24 text-center"
                disabled={confirming}
              />
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() =>
                  setTargetSeats(Math.min(maxSeats, targetSeats + 1))
                }
                disabled={targetSeats >= maxSeats || confirming}
              >
                <Plus className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                {seatsDelta === 0
                  ? `${currentSeats} seats (no change)`
                  : isIncrease
                    ? `(+${seatsDelta} new)`
                    : `(${seatsDelta} fewer)`}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              Currently using {totalUsedSeats} of {currentSeats} seats
            </p>
          </div>

          {/* Preview Section */}
          {loadingPreview ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : preview && seatsDelta !== 0 ? (
            <div className="space-y-4 rounded-lg border p-4">
              <div className="flex justify-between text-sm">
                <span>
                  {isIncrease ? "Additional seats" : "Seats to remove"}
                </span>
                <span className="font-medium">
                  {isIncrease ? `+${seatsDelta}` : seatsDelta}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span>
                  {isIncrease ? "Prorated charge" : "Prorated credit"}
                  <span className="text-muted-foreground ml-1">
                    (~${preview.proratedPerSeat.toFixed(2)}/seat)
                  </span>
                </span>
                <span
                  className={`font-medium ${isDecrease ? "text-green-600" : ""}`}
                >
                  {isIncrease
                    ? `$${preview.proratedCharge.toFixed(2)}`
                    : `+$${preview.proratedCredit.toFixed(2)}`}
                </span>
              </div>
              <div className="border-t pt-3 flex justify-between">
                <span className="font-medium">
                  {isIncrease ? "Total due today" : "Credit to account"}
                </span>
                <span
                  className={`font-semibold text-lg ${isDecrease ? "text-green-600" : ""}`}
                >
                  {isIncrease
                    ? `$${preview.totalDue.toFixed(2)}`
                    : `+$${preview.proratedCredit.toFixed(2)}`}
                </span>
              </div>
              {preview.paymentMethod && isIncrease && (
                <div className="flex justify-between text-sm text-muted-foreground">
                  <span>Payment method</span>
                  <span>{preview.paymentMethod}</span>
                </div>
              )}
              <div className="flex justify-between text-sm text-muted-foreground">
                <span>
                  Next invoice
                  {formatUnixDate(preview.currentPeriodEnd) &&
                    ` (${formatUnixDate(preview.currentPeriodEnd)})`}
                </span>
                <span>${preview.nextInvoiceAmount.toFixed(2)}</span>
              </div>
            </div>
          ) : null}

          {/* Error Message */}
          {error && (
            <div className="p-3 bg-red-50 dark:bg-red-950/20 border border-red-200 dark:border-red-900 rounded-md">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={confirming}
          >
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={
              confirming || loadingPreview || !preview || seatsDelta === 0
            }
          >
            {confirming ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin mr-2" />
                Processing...
              </>
            ) : (
              getButtonText()
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
