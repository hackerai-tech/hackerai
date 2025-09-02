"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { LogOut, Sparkle, CreditCard, LifeBuoy } from "lucide-react";
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
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";

const NEXT_PUBLIC_HELP_CENTER_URL =
  process.env.NEXT_PUBLIC_HELP_CENTER_URL || "https://help.hackerai.co/en/";

const SidebarUserNav = () => {
  const { user } = useAuth();
  const { hasProPlan, isCheckingProPlan } = useGlobalState();
  const { handleUpgrade } = useUpgrade();

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
          <div className="flex items-center gap-3 p-3 cursor-pointer hover:bg-sidebar-accent/50 rounded-md transition-colors">
            <Avatar className="h-8 w-8">
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
          </div>
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
              <Sparkle className="mr-2 h-4 w-4" />
              <span>Upgrade to Pro</span>
            </DropdownMenuItem>
          )}

          {/* Show manage subscription option for pro users */}
          {!isCheckingProPlan && isProUser && (
            <DropdownMenuItem onClick={() => redirectToBillingPortal()}>
              <CreditCard className="mr-2 h-4 w-4" />
              <span>Manage Subscription</span>
            </DropdownMenuItem>
          )}

          <DropdownMenuItem onClick={handleHelpCenter}>
            <LifeBuoy className="mr-2 h-4 w-4" />
            <span>Help Center</span>
          </DropdownMenuItem>

          <DropdownMenuItem onClick={handleSignOut} variant="destructive">
            <LogOut className="mr-2 h-4 w-4" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default SidebarUserNav;
