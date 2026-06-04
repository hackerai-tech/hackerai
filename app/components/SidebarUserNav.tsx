"use client";

import React, { useState, useCallback, useEffect } from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useAction, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  LogOut,
  Sparkle,
  LifeBuoy,
  ChevronRight,
  ChevronDown,
  Settings,
  CircleUserRound,
  Gauge,
  Download,
  ExternalLink,
  RefreshCw,
  Gift,
  X,
} from "lucide-react";
import Link from "next/link";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { redirectToPricing } from "../hooks/usePricingDialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { useIsStandalone } from "@/hooks/use-is-standalone";
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
import { clientLogout } from "@/lib/utils/logout";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { ReferralRewardDialog } from "./ReferralRewardDialog";

const NEXT_PUBLIC_HELP_CENTER_URL =
  process.env.NEXT_PUBLIC_HELP_CENTER_URL || "https://help.hackerai.co/en/";

const REFERRAL_CARD_DISMISSED_COOKIE = "referral_sidebar_dismissed";

const readCookie = (name: string): string | null => {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp(
      `(?:^|; )${name.replace(/([.$?*|{}()[\]\\/+^])/g, "\\$1")}=([^;]*)`,
    ),
  );
  return match ? decodeURIComponent(match[1]) : null;
};

const writeCookie = (name: string, value: string, days: number) => {
  if (typeof document === "undefined") return;
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
};

const ReferralSidebarCard = ({
  isCollapsed,
  onOpen,
}: {
  isCollapsed: boolean;
  onOpen: () => void;
}) => {
  const [dismissed, setDismissed] = useState(
    () => readCookie(REFERRAL_CARD_DISMISSED_COOKIE) === "1",
  );

  if (dismissed) return null;

  const handleDismiss = (e: React.MouseEvent) => {
    e.stopPropagation();
    writeCookie(REFERRAL_CARD_DISMISSED_COOKIE, "1", 365);
    setDismissed(true);
  };

  if (isCollapsed) {
    return (
      <div className="mb-1">
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                data-testid="referral-button-collapsed"
                variant="secondary"
                size="sm"
                className="h-8 w-full border-0 px-2"
                onClick={onOpen}
                aria-label="Refer a friend"
              >
                <Gift className="size-4" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right">
              <p>Refer a friend</p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    );
  }

  return (
    <div className="group/referral-card relative mb-2">
      <button
        type="button"
        onClick={onOpen}
        aria-label="Refer a friend and earn credits per paid referral"
        className="bg-muted/50 hover:bg-muted/80 border-sidebar-border flex w-full cursor-pointer items-center gap-3 rounded-xl border p-3 pr-9 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="bg-background/70 border-sidebar-border flex size-8 shrink-0 items-center justify-center rounded-full border">
          <Gift className="size-4" />
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-foreground truncate text-sm font-medium leading-none">
            Refer a friend
          </p>
          <p className="text-muted-foreground truncate text-xs">
            Earn credits per paid referral
          </p>
        </div>
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        aria-label="Dismiss referral card"
        title="Dismiss"
        className="bg-background/80 text-muted-foreground hover:bg-background hover:text-foreground border-sidebar-border absolute top-2 right-2 flex size-6 items-center justify-center rounded-full border opacity-100 shadow-sm transition-[opacity,colors] focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none [@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/referral-card:opacity-100"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};

const GithubIcon = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} {...props}>
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

const XIcon = ({ className, ...props }: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox="0 0 24 24" fill="currentColor" className={className} {...props}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

// Upgrade banner component
const UpgradeBanner = ({ isCollapsed }: { isCollapsed: boolean }) => {
  const { isCheckingProPlan, subscription } = useGlobalState();
  const isProUser = subscription !== "free";

  // Don't show for pro users or while checking
  if (isCheckingProPlan || isProUser) {
    return null;
  }

  const handleUpgrade = () => {
    redirectToPricing();
  };

  return (
    <div className="relative">
      {!isCollapsed && (
        <div className="relative rounded-t-2xl bg-premium-bg backdrop-blur-sm transition-all duration-200">
          <div
            role="button"
            tabIndex={0}
            onClick={handleUpgrade}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleUpgrade();
              }
            }}
            className="group relative z-10 flex w-full items-center rounded-t-2xl py-2.5 px-4 text-xs border border-sidebar-border hover:bg-premium-hover transition-all duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:outline-none cursor-pointer"
            aria-label="Upgrade your plan"
          >
            <span className="flex items-center gap-2.5">
              <Sparkle className="h-4 w-4 text-premium-text fill-current" />
              <span className="text-xs font-medium text-premium-text">
                Upgrade your plan
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

const SidebarUserNav = ({ isCollapsed = false }: { isCollapsed?: boolean }) => {
  const { user } = useAuth();
  const { isCheckingProPlan, subscription } = useGlobalState();
  const [rateLimitsExpanded, setRateLimitsExpanded] = useState(false);
  const [referralDialogOpen, setReferralDialogOpen] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{
    monthly: {
      remaining: number;
      limit: number;
      used: number;
      usagePercentage: number;
      resetTime: string | null;
    };
    monthlyBudgetUsd: number;
  } | null>(null);
  const [isLoadingUsage, setIsLoadingUsage] = useState(false);
  const [usageFetchFailed, setUsageFetchFailed] = useState(false);
  const isMobile = useIsMobile();
  const isStandalone = useIsStandalone();
  const isPaidUser = subscription !== "free";

  const getAgentRateLimitStatus = useAction(
    api.rateLimitStatus.getAgentRateLimitStatus,
  );

  const extraUsageSettings = useQuery(api.extraUsage.getExtraUsageSettings);
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
  );
  const extraUsageEnabled = userCustomization?.extra_usage_enabled ?? false;
  const extraUsageBalanceDollars = extraUsageSettings?.balanceDollars ?? 0;
  const extraUsageMonthlySpentDollars =
    extraUsageSettings?.monthlySpentDollars ?? 0;
  const extraUsageMonthlyCapDollars = extraUsageSettings?.monthlyCapDollars;
  const extraUsageMonthlyLimitLabel =
    extraUsageMonthlyCapDollars != null
      ? `$${extraUsageMonthlyCapDollars.toFixed(2)} limit`
      : "No limit";

  const fetchTokenUsage = useCallback(async () => {
    if (!isPaidUser) return;
    setIsLoadingUsage(true);
    try {
      const status = await getAgentRateLimitStatus({ subscription });
      setTokenUsage(status);
      setUsageFetchFailed(false);
    } catch {
      setUsageFetchFailed(true);
    } finally {
      setIsLoadingUsage(false);
    }
  }, [subscription, isPaidUser, getAgentRateLimitStatus]);

  // Reset error state when subscription changes so it can retry
  useEffect(() => {
    setUsageFetchFailed(false);
  }, [subscription]);

  useEffect(() => {
    if (
      rateLimitsExpanded &&
      !tokenUsage &&
      !isLoadingUsage &&
      !usageFetchFailed
    ) {
      fetchTokenUsage();
    }
  }, [
    rateLimitsExpanded,
    tokenUsage,
    isLoadingUsage,
    usageFetchFailed,
    fetchTokenUsage,
  ]);

  if (!user) return null;

  // Determine if user has pro subscription
  const isProUser = subscription !== "free";

  const handleLogOut = () => {
    clientLogout();
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
      "https://x.com/PentestGPT",
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

  const includedUsageRemainingPercentage =
    tokenUsage && tokenUsage.monthly.limit > 0
      ? Math.round(
          (tokenUsage.monthly.remaining / tokenUsage.monthly.limit) * 100,
        )
      : 0;

  return (
    <div className="relative">
      <ReferralRewardDialog
        open={referralDialogOpen}
        onOpenChange={setReferralDialogOpen}
      />

      {/* Referral card for paid users */}
      {isPaidUser && !isCheckingProPlan && (
        <ReferralSidebarCard
          isCollapsed={isCollapsed}
          onOpen={() => setReferralDialogOpen(true)}
        />
      )}

      {/* Upgrade banner above user nav */}
      <UpgradeBanner isCollapsed={isCollapsed} />

      {/* Upgrade button for collapsed state */}
      {isCollapsed && !isCheckingProPlan && !isProUser && (
        <div className="mb-1">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="upgrade-button-collapsed"
                  variant="secondary"
                  size="sm"
                  className="w-full h-8 px-2 bg-premium-bg text-premium-text hover:bg-premium-hover border-0"
                  onClick={redirectToPricing}
                >
                  <Sparkle className="h-4 w-4 fill-current" />
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
                data-testid="user-menu-button-collapsed"
                type="button"
                className="flex items-center justify-center p-2 cursor-pointer hover:bg-sidebar-accent/50 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full"
                aria-haspopup="menu"
                aria-label={`Open user menu for ${getDisplayName()}`}
              >
                <Avatar data-testid="user-avatar" className="h-7 w-7">
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
              data-testid="user-menu-button"
              type="button"
              className="flex items-center gap-3 p-3 cursor-pointer hover:bg-sidebar-accent/50 rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 w-full text-left"
              aria-haspopup="menu"
              aria-label={`Open user menu for ${getDisplayName()}`}
            >
              <Avatar data-testid="user-avatar" className="h-7 w-7">
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
                <div
                  data-testid="subscription-badge"
                  className="text-xs text-sidebar-accent-foreground truncate"
                >
                  {subscription === "ultra"
                    ? "Ultra"
                    : subscription === "team"
                      ? "Team"
                      : subscription === "pro-plus"
                        ? "Pro+"
                        : subscription === "pro"
                          ? "Pro"
                          : "Free"}
                </div>
              </div>
            </button>
          )}
        </DropdownMenuTrigger>

        <DropdownMenuContent
          className="w-[calc(var(--radix-dropdown-menu-trigger-width)-12px)] min-w-[240px] rounded-2xl py-1.5"
          align="center"
          side="top"
          sideOffset={0}
        >
          <DropdownMenuLabel className="font-normal py-1.5">
            <div className="flex items-center space-x-2">
              <CircleUserRound className="h-4 w-4 text-muted-foreground flex-shrink-0" />
              <p
                data-testid="user-email"
                className="leading-none text-muted-foreground truncate min-w-0 text-sm"
              >
                {user.email}
              </p>
            </div>
          </DropdownMenuLabel>

          <DropdownMenuSeparator />

          {(subscription === "pro" || subscription === "pro-plus") && (
            <DropdownMenuItem
              data-testid="upgrade-menu-item"
              onClick={redirectToPricing}
              className="py-1.5"
            >
              <Sparkle className="mr-2 h-4 w-4 text-foreground" />
              <span>Upgrade Plan</span>
            </DropdownMenuItem>
          )}

          {isPaidUser && (
            <div>
              <DropdownMenuItem
                data-testid="referral-menu-item"
                onSelect={() => setReferralDialogOpen(true)}
                className="py-1.5"
              >
                <Gift className="mr-2 h-4 w-4 text-foreground" />
                <span>Refer a friend</span>
              </DropdownMenuItem>

              <DropdownMenuItem
                onSelect={(e) => {
                  e.preventDefault();
                  setRateLimitsExpanded(!rateLimitsExpanded);
                }}
                className="py-1.5"
              >
                <Gauge className="mr-2 h-4 w-4 text-foreground" />
                <span className="flex-1">Usage</span>
                {rateLimitsExpanded ? (
                  <ChevronDown className="ml-auto h-4 w-4 text-muted-foreground" />
                ) : (
                  <ChevronRight className="ml-auto h-4 w-4 text-muted-foreground" />
                )}
              </DropdownMenuItem>
              {rateLimitsExpanded && (
                <div className="px-3 pb-2 space-y-0.5">
                  {isLoadingUsage ? (
                    <div className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
                      <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                      <span>Loading...</span>
                    </div>
                  ) : tokenUsage ? (
                    <>
                      <div className="flex items-center justify-between py-1.5 text-sm">
                        <span className="text-muted-foreground">Included</span>
                        <div className="flex items-center gap-3 tabular-nums text-muted-foreground">
                          <span>{includedUsageRemainingPercentage}% left</span>
                          {tokenUsage.monthly.resetTime && (
                            <span>
                              {new Date(
                                tokenUsage.monthly.resetTime,
                              ).toLocaleDateString(undefined, {
                                month: "short",
                                day: "numeric",
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                      {extraUsageEnabled && (
                        <>
                          <div className="flex items-center justify-between py-1.5 text-sm">
                            <span className="text-muted-foreground">
                              Extra balance
                            </span>
                            <span className="min-w-0 text-right tabular-nums text-muted-foreground">
                              ${extraUsageBalanceDollars.toFixed(2)} available
                            </span>
                          </div>
                          <div className="flex items-center justify-between py-1.5 text-sm">
                            <span className="text-muted-foreground">
                              This month
                            </span>
                            <div className="ml-3 flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-0.5 text-right tabular-nums text-muted-foreground">
                              <span>
                                ${extraUsageMonthlySpentDollars.toFixed(2)}{" "}
                                spent
                              </span>
                              <span className="text-muted-foreground/60">
                                /
                              </span>
                              <span>{extraUsageMonthlyLimitLabel}</span>
                            </div>
                          </div>
                        </>
                      )}
                    </>
                  ) : (
                    <div className="py-1.5 text-sm text-muted-foreground">
                      Unable to load usage
                    </div>
                  )}
                  <button
                    onClick={() => openSettingsDialog("Extra Usage")}
                    className="-mx-3 px-3 w-[calc(100%+1.5rem)] flex items-center gap-2.5 py-1.5 rounded-md text-left text-sm hover:bg-muted transition-colors"
                    aria-label="Open extra usage settings"
                    tabIndex={0}
                  >
                    <span className="flex-1">Extra usage</span>
                    <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </div>
              )}
            </div>
          )}

          <DropdownMenuItem
            data-testid="settings-button"
            onClick={() => openSettingsDialog()}
            className="py-1.5"
          >
            <Settings className="mr-2 h-4 w-4 text-foreground" />
            <span>Settings</span>
          </DropdownMenuItem>

          {!isStandalone && (
            <DropdownMenuItem asChild className="py-1.5">
              <Link href="/download">
                <Download className="mr-2 h-4 w-4 text-foreground" />
                <span>{isMobile ? "Install App" : "Download App"}</span>
              </Link>
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <DropdownMenuItem className="gap-4 cursor-pointer py-1.5">
                <LifeBuoy className="h-4 w-4 text-foreground" />
                <span>Help</span>
                <ChevronRight className="ml-auto h-4 w-4" />
              </DropdownMenuItem>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side={isMobile ? "top" : "right"}
              align={isMobile ? "center" : "start"}
              sideOffset={isMobile ? 8 : 4}
              className="rounded-2xl"
            >
              <DropdownMenuItem onClick={handleHelpCenter} className="py-1.5">
                <LifeBuoy className="mr-2 h-4 w-4 text-foreground" />
                <span>Help Center</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleGitHub} className="py-1.5">
                <GithubIcon className="mr-2 h-4 w-4 text-foreground" />
                <span>Source Code</span>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={handleXCom} className="py-1.5">
                <XIcon className="mr-2 h-4 w-4 text-foreground" />
                <span>Social</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenuItem
            data-testid="logout-button"
            onClick={handleLogOut}
            className="py-1.5"
          >
            <LogOut className="mr-2 h-4 w-4 text-foreground" />
            <span>Log out</span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
};

export default SidebarUserNav;
