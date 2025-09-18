"use client";

import React, { useState } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  LogOut,
  Sparkle,
  LifeBuoy,
  Trash2,
  Github,
  ChevronRight,
  Settings,
  Settings2,
  CircleUserRound,
} from "lucide-react";
import { useMutation } from "convex/react";
import { api } from "@/convex/_generated/api";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
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
import { CustomizeHackerAIDialog } from "./CustomizeHackerAIDialog";
import { SettingsDialog } from "./SettingsDialog";

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
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [showCustomizeDialog, setShowCustomizeDialog] = useState(false);
  const [showSettingsDialog, setShowSettingsDialog] = useState(false);
  const isMobile = useIsMobile();

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
    <div className="relative">
      {/* Upgrade button outside of dropdown trigger when collapsed */}
      {isCollapsed && !isCheckingProPlan && !isProUser && (
        <div className="mb-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full h-8 px-2 bg-primary"
                  onClick={redirectToPricing}
                >
                  <Sparkle className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Upgrade Plan</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          {isCollapsed ? (
            /* Collapsed state - only show avatar */
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
              <div
                className={`flex-1 min-w-0 ${!isCheckingProPlan && !isProUser ? "pr-20" : ""}`}
              >
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

        {/* Upgrade button outside of dropdown trigger when expanded */}
        {!isCollapsed && !isCheckingProPlan && !isProUser && (
          <div className="absolute top-3 right-3">
            <Button
              variant="secondary"
              size="sm"
              className=""
              onClick={redirectToPricing}
            >
              Upgrade
            </Button>
          </div>
        )}

        <DropdownMenuContent
          className="w-56"
          align="end"
          side="top"
          sideOffset={8}
        >
          <DropdownMenuLabel className="font-normal">
            <div className="flex items-center space-x-2">
              <CircleUserRound className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p className="leading-none text-muted-foreground truncate min-w-0">
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          {/* Show upgrade option for non-pro users */}
          {!isCheckingProPlan && !isProUser && (
            <DropdownMenuItem onClick={redirectToPricing}>
              <Sparkle className="mr-2 h-4 w-4 text-foreground" />
              <span>Upgrade to Pro</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onClick={() => setShowCustomizeDialog(true)}>
            <Settings2 className="mr-2 h-4 w-4 text-foreground" />
            <span>Personalization</span>
          </DropdownMenuItem>

          <DropdownMenuItem onClick={() => setShowSettingsDialog(true)}>
            <Settings className="mr-2 h-4 w-4 text-foreground" />
            <span>Settings</span>
          </DropdownMenuItem>

          <DropdownMenuItem onClick={() => setShowDeleteDialog(true)}>
            <Trash2 className="mr-2 h-4 w-4 text-foreground" />
            <span>Delete all chats</span>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <DropdownMenuItem className="gap-4 cursor-pointer">
                <LifeBuoy className="h-4 w-4 text-foreground" />
                <span>Help</span>
                <ChevronRight className="ml-auto h-4 w-4" />
              </DropdownMenuItem>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isMobile ? "top" : "right"}
              align={isMobile ? "center" : "start"}
              sideOffset={isMobile ? 8 : 4}
            >
              <DropdownMenuItem onClick={handleHelpCenter}>
                <LifeBuoy className="mr-2 h-4 w-4 text-foreground" />
                <span>Help Center</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleGitHub}>
                <Github className="mr-2 h-4 w-4 text-foreground" />
                <span>Source Code</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleXCom}>
                <XIcon className="mr-2 h-4 w-4 text-foreground" />
                <span>Social</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenuItem onClick={handleSignOut}>
            <LogOut className="mr-2 h-4 w-4 text-foreground" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Settings Dialog */}
      <SettingsDialog
        open={showSettingsDialog}
        onOpenChange={setShowSettingsDialog}
      />

      {/* Customize HackerAI Dialog */}
      <CustomizeHackerAIDialog
        open={showCustomizeDialog}
        onOpenChange={setShowCustomizeDialog}
      />

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
