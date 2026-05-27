"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";
import { Check, Copy, Gift, Share2, Sparkles, UserCheck } from "lucide-react";
import { toast } from "sonner";

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL ||
  (typeof window !== "undefined" ? window.location.origin : "");

export function ReferralRewardEntry({
  isCollapsed,
  isFreeUser,
}: {
  isCollapsed: boolean;
  isFreeUser: boolean;
}) {
  const { user } = useAuth();

  return (
    <ReferralRewardEntryContent
      isCollapsed={isCollapsed}
      isFreeUser={isFreeUser}
      userId={user?.id}
    />
  );
}

export function ReferralRewardEntryContent({
  isCollapsed,
  isFreeUser,
  userId,
}: {
  isCollapsed: boolean;
  isFreeUser: boolean;
  userId?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const lastCapturedUserRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!userId) {
      lastCapturedUserRef.current = null;
      return;
    }
    if (!isFreeUser || lastCapturedUserRef.current === userId) {
      return;
    }
    lastCapturedUserRef.current = userId;
    captureAuthenticatedEvent("referral_invite_impression", {
      placement: "sidebar_footer",
      collapsed: isCollapsed,
    });
  }, [isCollapsed, isFreeUser, userId]);

  if (!userId || !isFreeUser) return null;

  const openDialog = () => {
    captureAuthenticatedEvent("referral_invite_opened", {
      placement: "sidebar_footer",
      collapsed: isCollapsed,
    });
    setOpen(true);
  };

  return (
    <>
      {isCollapsed ? (
        <div className="mb-2">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  data-testid="referral-button-collapsed"
                  variant="ghost"
                  size="sm"
                  className="h-8 w-full px-2"
                  onClick={openDialog}
                  aria-label="Share HackerAI"
                >
                  <Gift className="h-4 w-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right">
                <p>Share HackerAI</p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      ) : (
        <button
          type="button"
          data-testid="referral-button"
          onClick={openDialog}
          className={cn(
            "group/share-card pointer-events-auto mb-2 flex min-h-16 w-full cursor-pointer items-center justify-between gap-3 overflow-hidden rounded-xl border border-sidebar-border bg-muted/50 p-3 text-left transition-all hover:bg-muted/70 md:h-14",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
          )}
          aria-label="Share HackerAI"
        >
          <span className="flex min-w-0 flex-col justify-between gap-1">
            <span className="truncate text-base font-medium leading-none text-sidebar-foreground md:text-sm">
              Share HackerAI
            </span>
            <span className="truncate text-sm text-muted-foreground md:text-xs">
              10 credits per paid referral
            </span>
          </span>
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full border border-sidebar-border bg-muted/70 text-sidebar-foreground transition-all duration-200 group-hover/share-card:bg-sidebar-accent">
            <Gift className="h-4 w-4 fill-current" />
          </span>
        </button>
      )}

      <ReferralRewardDialog
        open={open}
        onOpenChange={setOpen}
        userId={userId}
      />
    </>
  );
}

export function ReferralRewardDialog({
  open,
  onOpenChange,
  userId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  userId?: string;
}) {
  const { user } = useAuth();
  const effectiveUserId = userId ?? user?.id;
  const [copied, setCopied] = React.useState(false);
  const [generatedCode, setGeneratedCode] = React.useState<string | null>(null);
  const getOrCreateReferralCode = useMutation(
    api.referrals.getOrCreateReferralCode,
  );
  const summary = useQuery(
    api.referrals.getReferralSummary,
    open && effectiveUserId ? {} : "skip",
  );

  const code = summary?.code ?? generatedCode;
  const inviteLink = code ? `${BASE_URL}/invite/${code}` : "";

  React.useEffect(() => {
    if (!open || !effectiveUserId || code) return;

    let cancelled = false;
    getOrCreateReferralCode({})
      .then((result) => {
        if (!cancelled) setGeneratedCode(result.code);
      })
      .catch(() => {
        toast.error("Unable to create referral link");
      });

    return () => {
      cancelled = true;
    };
  }, [code, effectiveUserId, getOrCreateReferralCode, open]);

  const copyInviteLink = async () => {
    if (!inviteLink) return;

    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopied(true);
      captureAuthenticatedEvent("referral_invite_copied", {
        referral_code: code,
      });
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error("Unable to copy link");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[calc(100vw-2rem)] max-w-lg rounded-2xl p-0">
        <div className="border-b px-5 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted">
              <Gift className="h-4 w-4" />
            </div>
            <div>
              <DialogTitle className="text-lg">Share HackerAI</DialogTitle>
              <DialogDescription className="text-sm">
                Give friends starter credits and earn credits when they upgrade.
              </DialogDescription>
            </div>
          </div>
        </div>

        <div className="space-y-5 px-5 py-5">
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Share", "your invite link", Share2],
              ["They join", "and get 10 credits", UserCheck],
              ["You earn", "10 credits on paid referral", Sparkles],
            ].map(([title, body, Icon]) => (
              <div
                key={title as string}
                className="rounded-lg border bg-muted/30 p-3"
              >
                <Icon className="mb-2 h-4 w-4 text-muted-foreground" />
                <div className="text-sm font-medium">{title as string}</div>
                <div className="text-xs text-muted-foreground">
                  {body as string}
                </div>
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-medium">Invite link</div>
            <div className="flex min-w-0 gap-2">
              <div
                data-testid="referral-link"
                className="flex min-h-10 flex-1 items-center rounded-md border bg-muted/30 px-3 text-sm text-muted-foreground"
              >
                <span className="truncate">
                  {inviteLink || "Creating referral link..."}
                </span>
              </div>
              <Button
                type="button"
                size="icon"
                variant="outline"
                onClick={copyInviteLink}
                disabled={!inviteLink}
                aria-label="Copy referral link"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 text-center">
            <div className="rounded-lg border p-3">
              <div className="text-lg font-semibold">
                {summary?.balanceCredits ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Credits</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-lg font-semibold">
                {summary?.signedUp ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Signed up</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-lg font-semibold">
                {summary?.activated ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Activated</div>
            </div>
            <div className="rounded-lg border p-3">
              <div className="text-lg font-semibold">
                {summary?.converted ?? 0}
              </div>
              <div className="text-xs text-muted-foreground">Paid</div>
            </div>
          </div>

          <p className="text-xs leading-relaxed text-muted-foreground">
            Rewards are limited to one per referred account. Self-referrals are
            not eligible. Referrer credits are awarded after the referred user
            starts a qualifying paid subscription.
          </p>
        </div>
      </DialogContent>
    </Dialog>
  );
}
