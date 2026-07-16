import Link from "next/link";
import { redirect } from "next/navigation";
import { getConvexClient } from "@/lib/db/convex-client";
import { ArrowRight, Gift } from "lucide-react";
import { api } from "@/convex/_generated/api";
import { Button } from "@/components/ui/button";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import {
  getReferralRewardConfig,
  isValidReferralCode,
} from "@/lib/referrals/config";
import { workos } from "@/app/api/workos";
import { PUBLIC_POSITIONING } from "@/lib/marketing/positioning";

export const runtime = "nodejs";

type SignupPageProps = {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

const firstValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value);

const buildAuthHref = (
  searchParams: Record<string, string | string[] | undefined>,
) => {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(searchParams)) {
    if (!value) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        params.append(key, item);
      }
      continue;
    }
    params.set(key, value);
  }

  const query = params.toString();
  return query ? `/signup/auth?${query}` : "/signup/auth";
};

const getSafeDisplayName = (user: {
  firstName?: string | null;
  lastName?: string | null;
}) => {
  const parts = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" ") : undefined;
};

const getReferralInviteContext = async (
  referralCode: string,
): Promise<{ active: boolean; referrerName?: string }> => {
  try {
    const invite = await getConvexClient().query(
      api.referrals.getReferralInvite,
      {
        serviceKey: process.env.CONVEX_SERVICE_ROLE_KEY!,
        referralCode,
      },
    );

    if (!invite?.active) return { active: false };

    try {
      const referrer = await workos.userManagement.getUser(
        invite.referrerUserId,
      );
      return { active: true, referrerName: getSafeDisplayName(referrer) };
    } catch (error) {
      console.warn("[signup] Failed to resolve referral referrer", {
        referralCode,
        referrerUserId: invite.referrerUserId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { active: true };
    }
  } catch (error) {
    console.warn("[signup] Failed to resolve referral invite", {
      referralCode,
      error: error instanceof Error ? error.message : String(error),
    });
    return { active: false };
  }
};

export default async function SignupPage({ searchParams }: SignupPageProps) {
  const params = await searchParams;
  const referralCode =
    firstValue(params.referral_code) ?? firstValue(params.ref);

  if (!referralCode || !isValidReferralCode(referralCode)) {
    redirect(buildAuthHref(params));
  }

  const invite = await getReferralInviteContext(referralCode);
  if (!invite.active) {
    redirect(
      buildAuthHref({
        ...params,
        referral_code: undefined,
        ref: undefined,
      }),
    );
  }

  const authHref = buildAuthHref({
    ...params,
    referral_code: referralCode,
  });
  const bonusUnits = getReferralRewardConfig().referredSignupBonusUnits;
  const bonusHeading =
    bonusUnits > 0
      ? `Sign up and get ${bonusUnits} extra free request${bonusUnits === 1 ? "" : "s"}`
      : "Sign up through a referral link";
  const referralLine = invite.referrerName
    ? `You're signing up through ${invite.referrerName}'s referral link. Create your account to redeem your starter requests.`
    : "You're signing up through a custom referral link. Create your account to redeem your starter requests.";

  return (
    <main className="bg-background text-foreground flex min-h-dvh items-center justify-center px-5 py-10">
      <div className="w-full max-w-xl">
        <div className="mb-14 flex justify-start">
          <HackerAISVG theme="dark" scale={0.15} />
        </div>

        <p className="text-muted-foreground mb-3 font-mono text-xs font-medium uppercase tracking-[0.2em]">
          {PUBLIC_POSITIONING.eyebrow}
        </p>
        <h1 className="text-4xl font-semibold tracking-normal text-balance md:text-5xl">
          Create your account
        </h1>
        <p className="text-muted-foreground mt-4 max-w-lg text-lg leading-relaxed text-pretty">
          Bring a real target, lab, or codebase. HackerAI is built for practical
          bug bounty, pentest, and security research workflows.
        </p>

        <div className="border-border bg-muted/25 mt-8 rounded-2xl border p-6">
          <div className="flex gap-4">
            <div className="bg-background border-border flex size-10 shrink-0 items-center justify-center rounded-xl border">
              <Gift className="size-5" />
            </div>
            <div className="space-y-2">
              <p className="text-xl font-semibold">{bonusHeading}</p>
              <p className="text-muted-foreground text-lg leading-relaxed">
                {referralLine}
              </p>
            </div>
          </div>
        </div>

        <Button asChild size="lg" className="mt-6 h-12 w-full text-base">
          <Link href={authHref}>
            Continue to sign up
            <ArrowRight className="size-4" />
          </Link>
        </Button>

        <p className="text-muted-foreground mt-8 text-center text-base">
          Already have an account?{" "}
          <Link
            className="text-foreground underline underline-offset-4"
            href="/login"
          >
            Log in
          </Link>
        </p>

        <p className="text-muted-foreground mx-auto mt-8 max-w-md text-center text-sm leading-relaxed">
          {PUBLIC_POSITIONING.audience} Provider policies and abuse controls
          still apply.
        </p>

        <p className="text-muted-foreground mx-auto mt-4 max-w-md text-center text-sm leading-relaxed">
          By continuing, you agree to the{" "}
          <Link
            className="underline underline-offset-4"
            href="/terms-of-service"
          >
            Terms of Service
          </Link>{" "}
          and{" "}
          <Link className="underline underline-offset-4" href="/privacy-policy">
            Privacy Policy
          </Link>
          . Learn how we handle your data on our{" "}
          <Link className="underline underline-offset-4" href="/trust">
            Security &amp; Trust
          </Link>{" "}
          page.
        </p>
      </div>
    </main>
  );
}
