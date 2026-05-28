"use client";

import React from "react";
import { Check, Copy, Gift, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md rounded-2xl">
        <DialogHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Gift className="h-5 w-5" />
          </div>
          <DialogTitle>Refer a friend</DialogTitle>
          <DialogDescription>
            Give credits to a friend. Get credits after they upgrade.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
            <RefreshCw className="h-4 w-4 animate-spin" />
            <span>Loading referral link...</span>
          </div>
        ) : error ? (
          <div className="rounded-md border border-destructive/25 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        ) : program ? (
          <div className="space-y-4">
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-2 text-sm font-medium">
                ${program.referredSignupRewardDollars} for them, $
                {program.referrerRewardDollars} for you
              </div>
              <p className="text-xs leading-5 text-muted-foreground">
                Your reward is granted when the referred account starts a paid
                HackerAI plan. Referral rewards may be withheld for ineligible
                or suspicious activity.
              </p>
            </div>

            <div className="flex gap-2">
              <Input
                readOnly
                value={program.active ? program.referralUrl : "Link inactive"}
                className="min-w-0 flex-1 text-sm"
                aria-label="Referral link"
              />
              <Button
                type="button"
                size="icon"
                onClick={copyLink}
                disabled={!program.active}
                aria-label="Copy referral link"
                title="Copy referral link"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border p-2">
                <div className="text-base font-semibold tabular-nums">
                  {program.stats.attributedSignups}
                </div>
                <div className="text-[11px] text-muted-foreground">Signups</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-base font-semibold tabular-nums">
                  {program.stats.paidConversions}
                </div>
                <div className="text-[11px] text-muted-foreground">Paid</div>
              </div>
              <div className="rounded-md border p-2">
                <div className="text-base font-semibold tabular-nums">
                  ${program.stats.awardedDollars}
                </div>
                <div className="text-[11px] text-muted-foreground">Awarded</div>
              </div>
            </div>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
