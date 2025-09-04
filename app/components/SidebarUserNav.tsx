"use client";

import React, { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  LogOut,
  Sparkle,
  CreditCard,
  LifeBuoy,
  Trash2,
  Github,
} from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import redirectToBillingPortal from "@/lib/actions/billing-portal";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const NEXT_PUBLIC_HELP_CENTER_URL =
  process.env.NEXT_PUBLIC_HELP_CENTER_URL || "https://help.hackerai.co/en/";

const XIcon = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} {...props}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const SidebarUserNav = ({ isCollapsed = false }: { isCollapsed?: boolean }) => {
  const { user } = useAuth();
  const { hasProPlan, isCheckingProPlan } = useGlobalState();
  const { handleUpgrade } = useUpgrade();
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteAllChats = useMutation(api.chats.deleteAllChats);

  if (!user) return null;

  // Determine if user has pro subscription
  const isProUser = hasProPlan;

  const handleSignOut = async () => {
    window.location.href = "/logout";
  };

  const handleHelpCenter = () => {
    const newWindow = window.open(
      NEXT_PUBLIC_HELP_CENTER_URL,
      "_blank",
      "noopener,noreferrer",
    );
    if (newWindow) {
      newWindow.opener = null;
    }
  };

  const handleGitHub = () => {
    const newWindow = window.open(
      "https://github.com/hackerai-tech/hackerai",
      "_blank",
      "noopener,noreferrer",
    );
    if (newWindow) {
      newWindow.opener = null;
    }
  };

  const handleXCom = () => {
    const newWindow = window.open(
      "https://x.com/hackerai_tech",
      "_blank",
      "noopener,noreferrer",
    );
    if (newWindow) {
      newWindow.opener = null;
    }
  };

  const handleDeleteAllChats = async () => {
    try {
      setIsDeleting(true);
      await deleteAllChats();
      setShowDeleteDialog(false);
      // Optionally redirect to home or show success message
      window.location.href = "/";
    } catch (error) {
      console.error("Failed to delete all chats:", error);
      // Optionally show error message to user
    } finally {
      setIsDeleting(false);
    }
  };

  const getUserInitials = () => {
    const firstName = user.firstName?.charAt(0)?.toUpperCase() || "";
    const lastName = user.lastName?.charAt(0)?.toUpperCase() || "";
    if (firstName && lastName) {
      return firstName + lastName;
    }
    if (firstName) {
      return firstName;
    }
    if (lastName) {
      return lastName;
    }
    return user.email?.charAt(0)?.toUpperCase() || "U";
  };

  const getDisplayName = () => {
    if (user.firstName && user.lastName) {
      return `${user.firstName} ${user.lastName}`;
    }
    return user.firstName || user.lastName || "User";
  };

  return (
    <div className="border-t border-sidebar-border">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isCollapsed ? (
            /* Collapsed state - only show avatar centered */
            <div className="mb-1">
              <button
                type="button"
                className="flex items-center justify-center p-2 cursor-pointer hover:bg-sidebar-accent/50 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full"
                aria-haspopup="menu"
                aria-label={`Open user menu for ${getDisplayName()}`}
              >
                <Avatar className="h-7 w-7">
                  <AvatarImage
                    src={user.profilePictureUrl || undefined}
                    alt={getDisplayName()}
                  />
                  <AvatarFallback className="text-xs">
                    {getUserInitials()}
                  </AvatarFallback>
                </Avatar>
              </button>
            </div>
          ) : (
            /* Expanded state - show full user info */
            <button
              type="button"
              className="flex items-center gap-3 p-3 cursor-pointer hover:bg-sidebar-accent/50 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full text-left"
              aria-haspopup="menu"
              aria-label={`Open user menu for ${getDisplayName()}`}
            >
              <Avatar className="h-7 w-7">
                <AvatarImage
                  src={user.profilePictureUrl || undefined}
                  alt={getDisplayName()}
                />
                <AvatarFallback className="text-xs">
                  {getUserInitials()}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-sidebar-foreground truncate">
                  {getDisplayName()}
                </div>
                <div className="text-xs text-sidebar-accent-foreground truncate">
                  {isProUser ? "Pro" : "Free"}
                </div>
              </div>
            </button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          className="w-56"
          align="end"
          side="top"
          sideOffset={8}
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex flex-col space-y-1">
              <p className="text-sm font-medium leading-none">
                {getDisplayName()}
              </p>
              <p className="text-xs leading-none text-muted-foreground">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          {/* Show upgrade option for non-pro users */}
          {!isCheckingProPlan && !isProUser && (
            <DropdownMenuItem onClick={handleUpgrade}>
              <Sparkle className="mr-2 h-4 w-4 text-foreground" />
              <span>Upgrade to Pro</span>
            </DropdownMenuItem>
          )}

          {/* Show manage subscription option for pro users */}
          {!isCheckingProPlan && isProUser && (
            <DropdownMenuItem onClick={() => redirectToBillingPortal()}>
              <CreditCard className="mr-2 h-4 w-4 text-foreground" />
              <span>Manage Subscription</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="gap-4">
              <LifeBuoy className="h-4 w-4 text-foreground" />
              <span>Help</span>
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onClick={handleHelpCenter}>
                <LifeBuoy className="mr-2 h-4 w-4 text-foreground" />
                <span>Help Center</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleGitHub}>
                <Github className="mr-2 h-4 w-4 text-foreground" />
                <span>GitHub</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleXCom}>
                <XIcon className="mr-2 h-4 w-4 text-foreground" />
                <span>X.com</span>
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>

          <DropdownMenuSeparator />

          <DropdownMenuItem onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="mr-2 h-4 w-4 text-foreground" />
            <span>Delete all chats</span>
          </DropdownMenuItem>

          <DropdownMenuItem onClick={handleSignOut} variant="destructive">
            <LogOut className="mr-2 h-4 w-4" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Delete All Chats Confirmation Dialog */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Clear your chat history - are you sure?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This action cannot be undone. This will permanently delete all
              your chats and remove all associated data from our servers.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteAllChats}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Confirm deletion"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default SidebarUserNav;
