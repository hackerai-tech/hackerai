"use client";

import React from "react";
import Image from "next/image";
import {
  Check,
  Coins,
  Copy,
  Link as LinkIcon,
  Sparkles,
  UserPlus,
  X,
  Zap,
} from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { toast } from "sonner";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { captureAuthenticatedEvent } from "@/lib/analytics/client";

type ReferralProgram = {
  code: string;
  active: boolean;
  referralUrl: string;
  referrerRewardDollars: number;
  referredSignupRewardDollars: number;
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

  React.useEffect(() => {
    if (!open) return;

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
          referrer_reward_dollars: body.referrerRewardDollars,
          referred_signup_reward_dollars: body.referredSignupRewardDollars,
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
      });
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Unable to copy referral link");
    }
  };

  const referrerReward = program?.referrerRewardDollars ?? 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="flex max-h-[95vh] max-w-lg flex-col gap-4 overflow-y-auto rounded-3xl p-6"
      >
        <DialogHeader className="sr-only">
          <DialogTitle>Refer and earn</DialogTitle>
          <DialogDescription>
            Earn ${referrerReward}+ when a friend upgrades.
          </DialogDescription>
        </DialogHeader>

        <div className="relative h-44 overflow-hidden rounded-2xl bg-[#101111]">
          <Image
            src="/images/referral-popup-hackerai.avif"
            alt=""
            fill
            priority
            sizes="(max-width: 640px) 100vw, 512px"
            className="object-cover"
          />
          <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/15 to-transparent" />
          <DialogClose
            aria-label="Close"
            className="absolute top-3 right-3 z-20 flex size-8 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur transition-colors hover:bg-black/65 focus:ring-2 focus:ring-white/40 focus:outline-none"
          >
            <X className="size-5" />
          </DialogClose>
          <div className="relative z-10 flex h-full max-w-[60%] flex-col p-4 text-white sm:max-w-[64%] sm:p-5">
            <div className="w-fit max-w-full rounded-full bg-black/55 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur sm:px-3 sm:py-1.5 sm:text-[13px]">
              Earn ${referrerReward} in credits
            </div>
            <div className="mt-auto">
              <div className="text-[26px] leading-[1.08] font-semibold sm:text-3xl sm:leading-tight">
                Spread the word
              </div>
              <div className="mt-1 text-xs text-white/65 sm:text-sm">
                and earn rewards
              </div>
            </div>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Sparkles className="h-4 w-4 animate-pulse" />
            <span>Loading your referral link…</span>
          </div>
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
                    They sign up and get <b>extra usage credits</b>
                  </span>
                </li>
                <li className="flex items-center gap-3">
                  <span className="bg-muted text-foreground flex size-9 shrink-0 items-center justify-center rounded-lg">
                    <Coins className="size-5" />
                  </span>
                  <span className="text-foreground text-base font-normal">
                    You get <b>${referrerReward} in credits</b> once they
                    subscribe to any paid plan
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
                      {program.active ? program.referralUrl : "Link inactive"}
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
                asChild
              >
                <a href="/terms-of-service" target="_blank" rel="noreferrer">
                  View Terms and Conditions
                </a>
              </Button>
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
