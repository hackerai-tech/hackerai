"use client";

import React from "react";
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
import { Loader2 } from "lucide-react";

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

  // Seat management dialog props
  showSeatDialog: boolean;
  setShowSeatDialog: (show: boolean) => void;
  currentSeats: number;
  newSeats: number;
  setNewSeats: (seats: number) => void;
  updatingSeats: boolean;
  handleUpdateSeats: () => void;
  totalUsedSeats: number;

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
  showSeatDialog,
  setShowSeatDialog,
  currentSeats,
  newSeats,
  setNewSeats,
  updatingSeats,
  handleUpdateSeats,
  totalUsedSeats,
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
              account, they'll need to log out and log back in after accepting
              the invite to access the team subscription.
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

      {/* Decrease Seats Dialog */}
      <Dialog
        open={showSeatDialog}
        onOpenChange={(open) => {
          setShowSeatDialog(open);
          if (!open) {
            setNewSeats(currentSeats);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove seats</DialogTitle>
            <DialogDescription>
              Reduce the number of seats for your team. The change will take
              effect at your next billing cycle and you'll be charged less.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <label htmlFor="seats" className="text-sm font-medium">
                Number of seats
              </label>
              <Input
                id="seats"
                type="number"
                min={Math.max(2, totalUsedSeats)}
                max={currentSeats}
                value={newSeats}
                onChange={(e) =>
                  setNewSeats(parseInt(e.target.value) || currentSeats)
                }
                disabled={updatingSeats}
              />
              <p className="text-xs text-muted-foreground">
                Currently using {totalUsedSeats} seat
                {totalUsedSeats !== 1 ? "s" : ""}
              </p>
            </div>
            {newSeats < currentSeats && (
              <div className="text-sm text-muted-foreground bg-muted p-3 rounded-md">
                Removing {currentSeats - newSeats} seat
                {currentSeats - newSeats !== 1 ? "s" : ""}.
              </div>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setShowSeatDialog(false);
                setNewSeats(currentSeats);
              }}
              disabled={updatingSeats}
            >
              Cancel
            </Button>
            <Button
              onClick={handleUpdateSeats}
              disabled={
                updatingSeats ||
                newSeats >= currentSeats ||
                newSeats < Math.max(2, totalUsedSeats)
              }
            >
              {updatingSeats ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                  Removing...
                </>
              ) : (
                "Remove seats"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
  React.useEffect(() => {
    if (open) {
      console.log(
        "[InviteAcceptedDialog] ✅ Dialog opened - user accepted team invite!",
      );
    }
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Welcome to the team! 🎉</DialogTitle>
          <DialogDescription>
            You've successfully joined the team. You now have access to all team
            plan features.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Got it</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
