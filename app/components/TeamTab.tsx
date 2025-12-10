"use client";

import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useGlobalState } from "@/app/contexts/GlobalState";
import {
  Loader2,
  Search,
  UserPlus,
  Users,
  MoreHorizontal,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TeamDialogs, ManageSeatsDialog } from "./TeamDialogs";
import { TeamMembersList } from "./TeamMembersList";
import { clientLogout } from "@/lib/utils/logout";

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

interface TeamInfo {
  teamId: string;
  teamName: string;
  currentSeats: number;
  totalSeats: number;
  availableSeats: number;
  billingPeriod: "monthly" | "yearly" | null;
}

const TeamTab = () => {
  const { subscription } = useGlobalState();
  const [members, setMembers] = useState<TeamMember[]>([]);
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [teamInfo, setTeamInfo] = useState<TeamInfo | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [revokingInvite, setRevokingInvite] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [memberToRemove, setMemberToRemove] = useState<TeamMember | null>(null);
  const [inviteToRevoke, setInviteToRevoke] =
    useState<PendingInvitation | null>(null);
  const [activeTab, setActiveTab] = useState<"all" | "pending">("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showManageSeatsDialog, setShowManageSeatsDialog] = useState(false);
  const [showLeaveDialog, setShowLeaveDialog] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const hasFetchedRef = React.useRef(false);

  const fetchMembers = async () => {
    try {
      setLoading(true);
      const response = await fetch("/api/team/members");

      if (!response.ok) {
        throw new Error("Failed to fetch team data");
      }

      const data = await response.json();
      setMembers(data.members || []);
      setInvitations(data.invitations || []);
      setTeamInfo(data.teamInfo || null);
      setIsAdmin(data.isAdmin || false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load data");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (subscription === "team" && !hasFetchedRef.current) {
      hasFetchedRef.current = true;
      fetchMembers();
    }
  }, [subscription]);

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!inviteEmail) {
      toast.error("Please enter an email address");
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(inviteEmail)) {
      toast.error("Please enter a valid email address");
      return;
    }

    try {
      setInviting(true);
      const response = await fetch("/api/team/invite", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: inviteEmail }),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to invite member");
      }

      toast.success("Member invited successfully!");
      setInviteEmail("");
      setShowInviteDialog(false);
      fetchMembers();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to invite member",
      );
    } finally {
      setInviting(false);
    }
  };

  const filteredMembers = members.filter((member) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    const firstName = member.firstName || "";
    const lastName = member.lastName || "";
    const name = `${firstName} ${lastName}`.trim().toLowerCase();
    const email = member.email.toLowerCase();
    return name.includes(query) || email.includes(query);
  });

  const filteredInvitations = invitations.filter((invitation) => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return invitation.email.toLowerCase().includes(query);
  });

  // Calculate total seats including pending invites
  const totalUsedSeats = members.length + invitations.length;
  const actualAvailableSeats = teamInfo
    ? teamInfo.totalSeats - totalUsedSeats
    : 0;

  const handleRemove = async () => {
    if (!memberToRemove) return;

    try {
      setRemoving(memberToRemove.id);
      const response = await fetch(
        `/api/team/members?id=${memberToRemove.id}`,
        {
          method: "DELETE",
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to remove member");
      }

      toast.success("Member removed successfully!");
      setMemberToRemove(null);
      fetchMembers();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to remove member",
      );
    } finally {
      setRemoving(null);
    }
  };

  const handleRevokeInvite = async () => {
    if (!inviteToRevoke) return;

    try {
      setRevokingInvite(inviteToRevoke.id);
      const response = await fetch(`/api/team/invite?id=${inviteToRevoke.id}`, {
        method: "DELETE",
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to revoke invitation");
      }

      toast.success("Invitation revoked successfully!");
      setInviteToRevoke(null);
      fetchMembers();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Failed to revoke invitation",
      );
    } finally {
      setRevokingInvite(null);
    }
  };

  const handleLeaveTeam = async () => {
    try {
      setLeaving(true);

      // Find current user's membership ID
      const currentUserMembership = members.find((m) => m.isCurrentUser);
      if (!currentUserMembership) {
        throw new Error("Could not find your membership");
      }

      const response = await fetch(
        `/api/team/members?id=${currentUserMembership.id}`,
        {
          method: "DELETE",
        },
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || "Failed to leave team");
      }

      toast.success("You have left the team. Logging out...");
      setShowLeaveDialog(false);

      // Log out the user to refresh their session
      clientLogout();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to leave team");
      setLeaving(false);
    }
  };

  if (subscription !== "team") {
    return (
      <div className="space-y-6">
        <div className="text-center py-8">
          <Users className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
          <p className="text-muted-foreground">
            Team management is only available for Team plan subscribers.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {/* Header */}
          <div className="flex items-start justify-between">
            <div className="space-y-1">
              <h2 className="text-2xl font-semibold">Members</h2>
              <p className="text-sm text-muted-foreground">
                {teamInfo ? (
                  <>
                    Team · {members.length}{" "}
                    {members.length === 1 ? "member" : "members"}
                    {invitations.length > 0 &&
                      ` · ${invitations.length} pending`}
                  </>
                ) : (
                  "Team"
                )}
              </p>
            </div>
            {!isAdmin && (
              <Button
                variant="outline"
                onClick={() => setShowLeaveDialog(true)}
                className="text-destructive hover:text-destructive"
              >
                Leave team
              </Button>
            )}
          </div>

          {/* Tabs and Actions */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-2">
              <Button
                variant={activeTab === "all" ? "secondary" : "ghost"}
                size="sm"
                onClick={() => setActiveTab("all")}
                className="rounded-md"
              >
                All members
              </Button>
              {isAdmin && (
                <Button
                  variant={activeTab === "pending" ? "secondary" : "ghost"}
                  size="sm"
                  onClick={() => setActiveTab("pending")}
                  className="rounded-md"
                >
                  Pending invites
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2 flex-1 max-w-md">
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  type="text"
                  placeholder="Search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-9"
                />
              </div>
              {isAdmin && (
                <>
                  <Button
                    onClick={() => setShowInviteDialog(true)}
                    disabled={actualAvailableSeats === 0}
                    className="gap-2"
                  >
                    <UserPlus className="h-4 w-4" />
                    Invite member
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => setShowManageSeatsDialog(true)}
                      >
                        <Settings className="h-4 w-4 mr-2" />
                        Manage seats
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
            </div>
          </div>

          {/* Members and Invitations Lists */}
          <TeamMembersList
            activeTab={activeTab}
            filteredMembers={filteredMembers}
            filteredInvitations={filteredInvitations}
            searchQuery={searchQuery}
            removing={removing}
            revokingInvite={revokingInvite}
            actualAvailableSeats={actualAvailableSeats}
            isAdmin={isAdmin}
            setMemberToRemove={setMemberToRemove}
            setInviteToRevoke={setInviteToRevoke}
            setShowInviteDialog={setShowInviteDialog}
          />

          {/* Seat limit info */}
          {teamInfo && isAdmin && (
            <div className="text-sm text-muted-foreground">
              {actualAvailableSeats > 0 ? (
                <span>
                  {actualAvailableSeats} seat
                  {actualAvailableSeats !== 1 ? "s" : ""} available of{" "}
                  {teamInfo.totalSeats}
                  {invitations.length > 0 &&
                    ` (${invitations.length} pending invite${invitations.length !== 1 ? "s" : ""})`}
                </span>
              ) : (
                <span>
                  {totalUsedSeats} of {teamInfo.totalSeats} seats in use.
                </span>
              )}
            </div>
          )}
        </>
      )}

      <TeamDialogs
        showInviteDialog={showInviteDialog}
        setShowInviteDialog={setShowInviteDialog}
        inviteEmail={inviteEmail}
        setInviteEmail={setInviteEmail}
        inviting={inviting}
        handleInvite={handleInvite}
        memberToRemove={memberToRemove}
        setMemberToRemove={setMemberToRemove}
        removing={removing}
        handleRemove={handleRemove}
        inviteToRevoke={inviteToRevoke}
        setInviteToRevoke={setInviteToRevoke}
        revokingInvite={revokingInvite}
        handleRevokeInvite={handleRevokeInvite}
        showLeaveDialog={showLeaveDialog}
        setShowLeaveDialog={setShowLeaveDialog}
        leaving={leaving}
        handleLeaveTeam={handleLeaveTeam}
      />

      <ManageSeatsDialog
        open={showManageSeatsDialog}
        onOpenChange={setShowManageSeatsDialog}
        currentSeats={teamInfo?.totalSeats || 0}
        totalUsedSeats={totalUsedSeats}
        onSuccess={() => {
          toast.success("Seats updated successfully!");
          fetchMembers();
        }}
      />
    </div>
  );
};

export { TeamTab };
