"use client";

import React from "react";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { useMutation, useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
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
import {
  Check,
  Copy,
  Crown,
  Gift,
  LinkIcon,
  MessageSquareText,
  X,
  Zap,
} from "lucide-react";
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
      <DialogContent
        showCloseButton={false}
        className="max-h-[95vh] w-[calc(100vw-2rem)] max-w-lg gap-4 overflow-y-auto rounded-3xl border-0 p-6 shadow-2xl"
      >
        <DialogTitle className="sr-only">Refer and earn</DialogTitle>
        <DialogDescription className="sr-only">
          Share HackerAI with friends and earn referral credits.
        </DialogDescription>

        <div className="relative overflow-hidden rounded-xl border bg-muted/40">
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-3 top-3 z-20 h-8 w-8 rounded-full bg-background/80 text-foreground shadow-sm backdrop-blur hover:bg-background"
              aria-label="Close"
            >
              <X className="h-4 w-4" />
            </Button>
          </DialogClose>

          <div className="absolute inset-0 bg-[linear-gradient(135deg,hsl(var(--muted)),hsl(var(--background)))]" />
          <div className="absolute inset-x-0 bottom-0 h-20 border-t bg-background/45" />
          <div className="relative flex min-h-[188px] flex-col justify-between p-5">
            <div className="flex items-start gap-3 pr-10">
              <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-background text-foreground shadow-sm">
                <Gift className="h-5 w-5 fill-current" />
              </div>
              <div className="min-w-0">
                <div className="text-xl font-semibold leading-tight text-foreground">
                  Share HackerAI
                </div>
                <div className="mt-1 max-w-[18rem] text-sm leading-5 text-muted-foreground">
                  Give friends 10 starter credits and earn 10 credits when they
                  upgrade.
                </div>
              </div>
            </div>

            <div className="mt-8 grid grid-cols-2 gap-2">
              <div className="rounded-2xl border bg-background/85 p-3 shadow-sm backdrop-blur">
                <div className="text-2xl font-semibold leading-none">
                  10 credits
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  for referred users
                </div>
              </div>
              <div className="rounded-2xl border bg-background/85 p-3 shadow-sm backdrop-blur">
                <div className="text-2xl font-semibold leading-none">
                  10 credits
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  for paid referrals
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="md:py-2">
          <div className="mb-3 text-base font-normal text-muted-foreground">
            How it works:
          </div>
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <Zap className="size-5 shrink-0 text-foreground" />
              <span className="text-base font-normal text-foreground">
                Share your invite link
              </span>
            </div>
            <div className="flex items-center gap-3">
              <Crown className="size-5 shrink-0 text-foreground" />
              <span className="text-base font-normal text-foreground">
                They sign up and get <b>extra 10 credits</b>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <MessageSquareText className="size-5 shrink-0 text-foreground" />
              <span className="text-base font-normal text-foreground">
                You get <b>10 credits</b> once they subscribe to a qualifying
                paid plan
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col">
          <span className="mb-3 flex items-center gap-4 pr-2 text-base font-normal text-muted-foreground">
            <span>
              <b>{summary?.signedUp ?? 0}</b> signed up,{" "}
              <b>{summary?.converted ?? 0}</b> paid referrals
            </span>
          </span>

          <div className="flex flex-col gap-3 rounded-xl bg-muted p-2 md:flex-row">
            <div
              data-testid="referral-link"
              className="flex h-10 min-w-0 flex-1 items-center rounded-lg bg-background px-2 text-sm text-muted-foreground"
            >
              <LinkIcon className="mr-2 size-5 shrink-0" />
              <span className="truncate">
                {inviteLink || "Creating referral link..."}
              </span>
            </div>
            <Button
              type="button"
              className="h-10 w-full rounded-lg px-4 md:w-auto"
              onClick={copyInviteLink}
              disabled={!inviteLink}
              aria-label="Copy referral link"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Copy className="h-4 w-4" />
              )}
              <span>{copied ? "Copied" : "Copy link"}</span>
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

        <p className="text-center text-xs leading-relaxed text-muted-foreground">
          One reward per referred account. No self-referrals. Referrer credits
          require a qualifying paid subscription.
        </p>
      </DialogContent>
    </Dialog>
  );
}
