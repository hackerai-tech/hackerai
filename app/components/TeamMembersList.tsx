"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Loader2, Trash2, Plus } from "lucide-react";

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

interface TeamMembersListProps {
  activeTab: "all" | "pending";
  filteredMembers: TeamMember[];
  filteredInvitations: PendingInvitation[];
  searchQuery: string;
  removing: string | null;
  revokingInvite: string | null;
  actualAvailableSeats: number;
  isAdmin: boolean;
  setMemberToRemove: (member: TeamMember) => void;
  setInviteToRevoke: (invitation: PendingInvitation) => void;
  setShowInviteDialog: (show: boolean) => void;
}

export const TeamMembersList = ({
  activeTab,
  filteredMembers,
  filteredInvitations,
  searchQuery,
  removing,
  revokingInvite,
  actualAvailableSeats,
  isAdmin,
  setMemberToRemove,
  setInviteToRevoke,
  setShowInviteDialog,
}: TeamMembersListProps) => {
  return (
    <>
      {/* Members Table */}
      {activeTab === "all" && (
        <div className="border rounded-lg">
          {/* Table Header */}
          <div
            className={`grid ${isAdmin ? "grid-cols-[2fr_2fr_1fr_auto]" : "grid-cols-[2fr_2fr_1fr]"} gap-4 px-4 py-3 border-b bg-muted/50 text-sm font-medium text-muted-foreground`}
          >
            <div>Name</div>
            <div>Email</div>
            <div>Role</div>
            {isAdmin && <div className="w-8"></div>}
          </div>

          {/* Table Body */}
          {filteredMembers.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? "No members found" : "No team members yet"}
            </div>
          ) : (
            <div>
              {filteredMembers.map((member, index) => (
                <div
                  key={member.id}
                  className={`grid ${isAdmin ? "grid-cols-[2fr_2fr_1fr_auto]" : "grid-cols-[2fr_2fr_1fr]"} gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors ${
                    index !== filteredMembers.length - 1 ? "border-b" : ""
                  }`}
                >
                  <div className="truncate">
                    {member.firstName || member.lastName
                      ? `${member.firstName} ${member.lastName}`.trim()
                      : member.email}
                    {member.isCurrentUser && (
                      <span className="text-muted-foreground ml-1">(You)</span>
                    )}
                  </div>
                  <div className="truncate text-muted-foreground">
                    {member.email}
                  </div>
                  <div className="capitalize">{member.role}</div>
                  {isAdmin && (
                    <div className="w-8">
                      {!member.isCurrentUser && (
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => setMemberToRemove(member)}
                          disabled={removing === member.id}
                          className="h-8 w-8"
                        >
                          {removing === member.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      )}
                    </div>
                  )}
                </div>
              ))}

              {/* Invite member row */}
              {isAdmin && (
                <button
                  onClick={() => setShowInviteDialog(true)}
                  disabled={actualAvailableSeats === 0}
                  className="flex items-center gap-2 px-4 py-3 w-full text-left hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="h-4 w-4" />
                  <span>Invite member</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Pending Invites Tab */}
      {activeTab === "pending" && isAdmin && (
        <div className="border rounded-lg">
          {/* Table Header */}
          <div className="grid grid-cols-[3fr_1fr_auto] gap-4 px-4 py-3 border-b bg-muted/50 text-sm font-medium text-muted-foreground">
            <div>Email</div>
            <div>Invited</div>
            <div className="w-8"></div>
          </div>

          {/* Table Body */}
          {filteredInvitations.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              {searchQuery ? "No invitations found" : "No pending invites"}
            </div>
          ) : (
            <div>
              {filteredInvitations.map((invitation, index) => (
                <div
                  key={invitation.id}
                  className={`grid grid-cols-[3fr_1fr_auto] gap-4 px-4 py-3 items-center hover:bg-muted/50 transition-colors ${
                    index !== filteredInvitations.length - 1 ? "border-b" : ""
                  }`}
                >
                  <div className="truncate text-muted-foreground">
                    {invitation.email}
                  </div>
                  <div className="text-sm text-muted-foreground">
                    {new Date(invitation.invitedAt).toLocaleDateString()}
                  </div>
                  <div className="w-8">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setInviteToRevoke(invitation)}
                      disabled={revokingInvite === invitation.id}
                      className="h-8 w-8"
                    >
                      {revokingInvite === invitation.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4" />
                      )}
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </>
  );
};
