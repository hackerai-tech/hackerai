"use client";

import React from "react";
import {
  ArrowLeft,
  Check,
  Coins,
  Copy,
  Gift,
  Link as LinkIcon,
  UserPlus,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";

type ReferralProgram = {
  code: string;
  active: boolean;
  referralUrl: string;
  referrerSubscriptionTier: string;
  referrerRewardDollars: number;
  referredSignupBonusUnits: number;
  stats: {
    attributedSignups: number;
    paidConversions: number;
    awardedDollars: number;
  };
};

type ReferralRewardDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ReferralRewardDialog({
  open,
  onOpenChange,
}: ReferralRewardDialogProps) {
  const [program, setProgram] = React.useState<ReferralProgram | null>(null);
  const [isLoading, setIsLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [view, setView] = React.useState<"main" | "guidelines">("main");

  React.useEffect(() => {
    if (!open) {
      setView("main");
      return;
    }

    let cancelled = false;
    setIsLoading(true);
    setError(null);
    setCopied(false);

    fetch("/api/referrals", { credentials: "include" })
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(body.error || "Unable to load referral link");
        }
        return body as ReferralProgram;
      })
      .then((body) => {
        if (cancelled) return;
        setProgram(body);
        captureAuthenticatedEvent("referral_modal_opened", {
          referral_code: body.code,
          referrer_subscription_tier: body.referrerSubscriptionTier,
          referrer_reward_dollars: body.referrerRewardDollars,
          referred_signup_bonus_units: body.referredSignupBonusUnits,
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(
          err instanceof Error ? err.message : "Unable to load referral",
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  const copyLink = async () => {
    if (!program?.referralUrl || !program.active) return;

    try {
      await navigator.clipboard.writeText(program.referralUrl);
      setCopied(true);
      toast.success("Referral link copied");
      captureAuthenticatedEvent("referral_link_copied", {
        referral_code: program.code,
        referrer_subscription_tier: program.referrerSubscriptionTier,
      });
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Unable to copy referral link");
    }
  };

  const referrerReward = program?.referrerRewardDollars ?? 0;
  const referrerRewardTitle = `Earn $${referrerReward} in extra usage credits`;
  const referrerRewardCopy = (
    <>
      You get <b>${referrerReward} in extra usage credits</b> when they upgrade
    </>
  );
  const referredSignupBonusUnits = program?.referredSignupBonusUnits ?? 0;
  const referredSignupBonusCopy =
    referredSignupBonusUnits > 0
      ? `${referredSignupBonusUnits} extra free request${referredSignupBonusUnits === 1 ? "" : "s"}`
      : "extra free requests";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[95vh] max-w-lg flex-col gap-4 overflow-y-auto rounded-3xl p-6">
        {view === "guidelines" ? (
          <>
            <DialogHeader className="flex flex-col gap-4 text-left sm:text-left">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-foreground w-fit gap-1 px-2"
                onClick={() => setView("main")}
              >
                <ArrowLeft className="size-4" />
                Back
              </Button>
              <DialogTitle className="text-lg leading-none font-medium">
                General referral guidelines
              </DialogTitle>
              <DialogDescription className="sr-only">
                How the ZHACKER referral program works and what activity is
                eligible for rewards.
              </DialogDescription>
            </DialogHeader>

            <div className="pb-6">
              <ul className="flex list-disc flex-col gap-2 px-5">
                <li>
                  <span className="text-muted-foreground text-sm">
                    Referral links are available to paid ZHACKER customers and
                    apply to new users who sign up through your link only.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    Rewards are earned once your invitee creates a new account
                    and subscribes to any paid ZHACKER plan. No credit is
                    granted for inactive or incomplete referrals.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    We may review referral activity and account quality to
                    prevent abuse, spam, disposable accounts, or other
                    low-quality participation.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    Each new user can generate only one (1) reward. No stacking
                    or loophole hunting.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    Deleting and recreating an account does not reset usage
                    limits or referral eligibility.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    Please avoid spamming or misusing your referral link to earn
                    credits without bringing legitimate users to the platform.
                    Our systems actively monitor referral engagement and flag
                    unusual activity.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    If we detect suspicious or non-compliant activity, we
                    reserve the right to withhold rewards or deactivate your
                    referral link.
                  </span>
                </li>
                <li>
                  <span className="text-muted-foreground text-sm">
                    We may update, pause, or discontinue this program at any
                    time as we continue to experiment and improve.
                  </span>
                </li>
              </ul>
              <p className="text-muted-foreground mt-4 px-5 text-sm">
                For complete terms of service and referral rules, see{" "}
                <a
                  href="/terms-of-service"
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground hover:text-foreground/80 underline"
                >
                  ZHACKER Terms
                </a>
                .
              </p>
            </div>
          </>
        ) : (
          <>
            <DialogHeader className="flex flex-col items-center gap-3 pt-2 text-center sm:text-center">
              <div className="bg-foreground/10 text-foreground flex size-14 items-center justify-center rounded-2xl">
                <Gift className="size-7" />
              </div>
              <DialogTitle className="text-2xl font-semibold">
                {referrerRewardTitle}
              </DialogTitle>
              <DialogDescription className="text-muted-foreground max-w-xs text-sm">
                Invite friends. When they upgrade, you both win.
              </DialogDescription>
            </DialogHeader>

            {isLoading ? (
              <>
                <div className="md:py-2">
                  <div className="text-muted-foreground mb-3 text-base font-normal">
                    How it works:
                  </div>
                  <ul className="flex flex-col gap-4" aria-hidden="true">
                    {[0, 1, 2].map((i) => (
                      <li key={i} className="flex items-center gap-3">
                        <Skeleton className="size-9 shrink-0 rounded-lg" />
                        <Skeleton className="h-4 w-56 max-w-full" />
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="flex flex-col">
                  <Skeleton className="mb-3 h-4 w-44" aria-hidden="true" />
                  <div
                    className="bg-muted flex flex-wrap items-center justify-center gap-3 rounded-xl p-2"
                    aria-hidden="true"
                  >
                    <Skeleton className="size-24 shrink-0 rounded-lg md:size-28" />
                    <div className="flex min-w-32 flex-1 flex-col gap-2">
                      <Skeleton className="hidden h-10 w-full rounded-lg md:block" />
                      <Skeleton className="h-10 w-full rounded-[10px]" />
                    </div>
                  </div>
                </div>

                <div className="flex justify-center" aria-hidden="true">
                  <Skeleton className="h-5 w-40" />
                </div>
                <span className="sr-only" role="status">
                  Loading your referral link…
                </span>
              </>
            ) : error ? (
              <div className="rounded-lg border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : program ? (
              <>
                <div className="md:py-2">
                  <div className="text-muted-foreground mb-3 text-base font-normal">
                    How it works:
                  </div>
                  <ul className="flex flex-col gap-4">
                    <li className="flex items-center gap-3">
                      <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Zap className="size-5" />
                      </span>
                      <span className="text-foreground text-base font-normal">
                        Share your invite link
                      </span>
                    </li>
                    <li className="flex items-center gap-3">
                      <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <UserPlus className="size-5" />
                      </span>
                      <span className="text-foreground text-base font-normal">
                        They sign up and get <b>{referredSignupBonusCopy}</b>
                      </span>
                    </li>
                    <li className="flex items-center gap-3">
                      <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                        <Coins className="size-5" />
                      </span>
                      <span className="text-foreground text-base font-normal">
                        {referrerRewardCopy}
                      </span>
                    </li>
                  </ul>
                </div>

                <div className="flex flex-col">
                  <span className="text-muted-foreground mb-3 flex items-center gap-4 pr-2 text-base font-normal">
                    <span>
                      <b className="tabular-nums">
                        {program.stats.attributedSignups}
                      </b>{" "}
                      signed up,{" "}
                      <b className="tabular-nums">
                        {program.stats.paidConversions}
                      </b>{" "}
                      converted
                      {program.stats.awardedDollars > 0 ? (
                        <>
                          ,{" "}
                          <b className="tabular-nums">
                            ${program.stats.awardedDollars}
                          </b>{" "}
                          earned
                        </>
                      ) : null}
                    </span>
                  </span>

                  <div className="bg-muted flex flex-wrap items-center justify-center gap-3 rounded-xl p-2">
                    {program.active ? (
                      <div className="flex size-24 shrink-0 items-center justify-center rounded-lg border bg-white p-2 md:size-28">
                        <QRCodeSVG
                          value={program.referralUrl}
                          bgColor="#ffffff"
                          fgColor="#000000"
                          level="M"
                          marginSize={0}
                          className="size-full"
                          role="img"
                          aria-label="Referral invite QR code"
                        />
                      </div>
                    ) : null}

                    <div className="flex min-w-32 flex-1 flex-col gap-2">
                      <div className="bg-background text-foreground hidden h-10 w-full items-center rounded-lg px-3 md:flex">
                        <LinkIcon className="text-muted-foreground mr-2 size-4 shrink-0" />
                        <span
                          className="text-foreground min-w-0 flex-1 truncate text-sm"
                          aria-label="Referral link"
                        >
                          {program.active
                            ? program.referralUrl
                            : "Link inactive"}
                        </span>
                      </div>
                      <Button
                        type="button"
                        onClick={copyLink}
                        disabled={!program.active}
                        className="h-10 w-full rounded-[10px]"
                        aria-label="Copy referral link"
                      >
                        {copied ? (
                          <>
                            <Check className="size-5" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="size-5" />
                            Copy link
                          </>
                        )}
                      </Button>
                    </div>
                  </div>
                </div>

                <div className="flex justify-center">
                  <Button
                    type="button"
                    variant="link"
                    size="xs"
                    className="text-foreground"
                    onClick={() => setView("guidelines")}
                  >
                    View Terms and Conditions
                  </Button>
                </div>
              </>
            ) : null}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
