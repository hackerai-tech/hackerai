"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Loader2, X } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import { useBillingRecoveryStatus } from "../hooks/useBillingRecoveryStatus";
import { BillingRecoveryPanel } from "./BillingRecoveryPanel";
import { navigateToAuth } from "../hooks/useTauri";
import {
  freeFeatures,
  proFeatures,
  proPlusFeatures,
  ultraFeatures,
  PRICING,
  PLAN_HEADERS,
} from "@/lib/pricing/features";
import BillingFrequencySelector from "./BillingFrequencySelector";
import UpgradeConfirmationDialog from "./UpgradeConfirmationDialog";
import { captureUpgradeCtaImpression } from "@/lib/analytics/client";
import type { PricingDialogContext } from "../hooks/usePricingDialog";
import {
  PRO_MONTHLY_PRICE_LOOKUP_KEY,
  type ProMonthlyPricePresentation,
} from "@/lib/pricing/pro-monthly";

interface PricingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  context?: PricingDialogContext;
}

interface PlanCardProps {
  planName: string;
  price: number | string;
  description: string;
  features: Array<{
    icon: React.ComponentType<{ className?: string }>;
    text: string;
  }>;
  buttonText: string;
  buttonVariant?: "default" | "secondary";
  buttonClassName?: string;
  onButtonClick?: () => void;
  isButtonDisabled?: boolean;
  isButtonLoading?: boolean;
  customClassName?: string;
  badgeText?: string;
  badgeClassName?: string;
  footerNote?: string;
  featureHeader?: string | null;
}

type PricingIntentCopy = {
  title: string;
  description: string;
  proDescription: string;
  proPlusDescription: string;
  ultraDescription: string;
  proButtonText: string;
  proPlusButtonText: string;
  ultraButtonText: string;
};

export function getPricingIntentCopy(
  context: PricingDialogContext | undefined,
  subscription: string,
): PricingIntentCopy | null {
  if (subscription !== "free") return null;

  const source = context?.source;
  const limitType = context?.limitType;
  const reason = context?.reason;

  if (source === "regional_subscription_first") {
    return {
      title: "Choose a subscription to start",
      description:
        "A subscription is required to send Ask requests or start Agent tasks. Choose the plan that fits your work.",
      proDescription: "Security questions and Agent tasks",
      proPlusDescription: "More usage for repeated Agent runs",
      ultraDescription: "Maximum room for intensive work",
      proButtonText: "Subscribe to Pro",
      proPlusButtonText: "Subscribe to Pro+",
      ultraButtonText: "Subscribe to Ultra",
    };
  }

  if (source === "agent_mode_gate") {
    return {
      title: "Unlock cloud Agent mode",
      description:
        "Use Agent without connecting a local sandbox, with higher limits, file uploads, and stronger models included.",
      proDescription: "Cloud agents and higher limits",
      proPlusDescription: "More usage for repeated Agent runs",
      ultraDescription: "Maximum room for serious workloads",
      proButtonText: "Use cloud Agent",
      proPlusButtonText: "Get more Agent usage",
      ultraButtonText: "Get Ultra",
    };
  }

  if (
    source === "limit_pressure" ||
    source === "rate_limit_error" ||
    limitType === "free_monthly" ||
    limitType === "daily_requests" ||
    reason === "free_monthly_exhausted" ||
    reason === "daily_requests_exhausted"
  ) {
    return {
      title: "Keep working",
      description:
        "Upgrade to continue today with higher usage limits, file uploads, and stronger models for heavier security work.",
      proDescription: "Continue with higher limits",
      proPlusDescription: "More room for heavier work",
      ultraDescription: "Maximum usage for intensive testing",
      proButtonText: "Continue with Pro",
      proPlusButtonText: "Keep going with Pro+",
      ultraButtonText: "Scale up with Ultra",
    };
  }

  return null;
}

const PlanCard: React.FC<PlanCardProps> = ({
  planName,
  price,
  description,
  features,
  buttonText,
  buttonVariant = "secondary",
  buttonClassName = "",
  onButtonClick,
  isButtonDisabled = false,
  isButtonLoading = false,
  customClassName = "",
  badgeText,
  badgeClassName = "",
  footerNote,
  featureHeader,
}) => {
  return (
    <div
      className={`border border-border md:min-h-[30rem] md:rounded-2xl relative flex w-full min-w-0 flex-col justify-center gap-4 rounded-xl px-6 py-6 text-sm bg-background ${customClassName}`}
    >
      <div className="relative flex flex-col mt-0">
        <div className="flex flex-col gap-5">
          <div className="flex min-h-10 items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-[28px] font-medium leading-tight">
              <span>{planName}</span>
              {badgeText ? (
                <Badge
                  className={`border-none rounded-4xl px-2 pt-1.5 pb-1.25 text-[11px] font-semibold bg-[#DCDBFF] text-[#615EEB] dark:bg-[#444378] dark:text-[#B9B7FF] ${badgeClassName}`}
                >
                  {badgeText}
                </Badge>
              ) : null}
            </div>
          </div>
          <div className="flex items-end gap-1.5">
            <div className="flex text-foreground">
              <div className="text-2xl text-muted-foreground">$</div>
              <div className="text-5xl">{price}</div>
            </div>
            <div className="flex items-baseline gap-1.5">
              <div className="mt-auto mb-0.5 flex h-full flex-col items-start">
                <p className="text-muted-foreground w-full text-xs">
                  USD / <br />
                  month
                </p>
              </div>
            </div>
          </div>
        </div>
        <p className="text-foreground text-base mt-4 font-medium">
          {description}
        </p>
      </div>

      <div className="mb-2.5 w-full">
        <Button
          onClick={onButtonClick}
          disabled={isButtonDisabled}
          className={`w-full ${buttonClassName}`}
          variant={buttonVariant}
          size="lg"
        >
          {isButtonLoading ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Upgrading...
            </>
          ) : (
            buttonText
          )}
        </Button>
      </div>

      <div className="flex flex-col grow gap-2">
        {featureHeader && (
          <p className="text-base font-semibold mb-2">{featureHeader}</p>
        )}
        <ul className="mb-2 flex flex-col gap-5">
          {features.map((feature, index) => (
            <li key={index} className="relative">
              <div className="flex justify-start gap-3.5">
                <feature.icon className="h-5 w-5 shrink-0" />
                <span className="text-foreground font-normal">
                  {feature.text}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>
      {footerNote ? (
        <p className="text-muted-foreground text-xs mt-auto">{footerNote}</p>
      ) : null}
    </div>
  );
};

const PricingDialog: React.FC<PricingDialogProps> = ({
  isOpen,
  onClose,
  context,
}) => {
  const { user, organizationId } = useAuth();
  const { subscription, isCheckingProPlan, setTeamPricingDialogOpen } =
    useGlobalState();
  const {
    upgradeLoading,
    handleUpgrade,
    billingReviewRequired,
    clearBillingReview,
  } = useUpgrade();
  const billing = useBillingRecoveryStatus(isOpen);
  const billingBlocked = Boolean(
    user &&
    (billing.isLoading ||
      billing.error ||
      billingReviewRequired ||
      billing.data?.checkoutRequiresReview ||
      billing.data?.subscriptionStatus === "past_due" ||
      billing.data?.subscriptionStatus === "unpaid"),
  );
  const checkBilling = async () => {
    const status = await billing.mutate();
    if (status && !status.checkoutRequiresReview) clearBillingReview?.();
    return status;
  };
  const [isYearly, setIsYearly] = React.useState(false);
  const capturedPricingCtaImpressionRef = React.useRef(false);
  const [proMonthlyPrice, setProMonthlyPrice] = React.useState<
    ProMonthlyPricePresentation | undefined
  >();
  const [proMonthlyPriceResolved, setProMonthlyPriceResolved] =
    React.useState(false);
  const [proMonthlyPriceUnavailable, setProMonthlyPriceUnavailable] =
    React.useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [pendingUpgrade, setPendingUpgrade] = React.useState<{
    plan: string;
    planName: string;
    price: number;
  } | null>(null);
  const pricingIntentCopy = getPricingIntentCopy(context, subscription);
  const monthlyProPrice =
    subscription === "free" && proMonthlyPrice
      ? proMonthlyPrice.displayedAmountDollars
      : PRICING.pro.monthly;
  const displayedMonthlyProPrice =
    subscription === "free" && proMonthlyPriceUnavailable
      ? "—"
      : subscription === "free" && !proMonthlyPriceResolved
        ? "…"
        : monthlyProPrice;

  React.useEffect(() => {
    if (!isOpen || proMonthlyPriceResolved) return;
    if (subscription !== "free") return;

    const controller = new AbortController();
    setProMonthlyPriceUnavailable(false);
    void fetch("/api/pricing/pro-monthly-experiment", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("Pro monthly price unavailable");
        const value = (await response.json()) as {
          priceLookupKey?: unknown;
          displayedAmountDollars?: unknown;
          currency?: unknown;
          billingInterval?: unknown;
          stripePriceId?: unknown;
        };
        if (controller.signal.aborted) return;
        const stripePriceId =
          typeof value.stripePriceId === "string" &&
          value.stripePriceId.length > 0
            ? value.stripePriceId
            : undefined;
        const isValid =
          value.priceLookupKey === PRO_MONTHLY_PRICE_LOOKUP_KEY &&
          value.displayedAmountDollars === PRICING.pro.monthly &&
          value.currency === "usd" &&
          value.billingInterval === "month" &&
          stripePriceId;
        if (!isValid) throw new Error("Invalid Pro monthly price");
        setProMonthlyPrice({
          priceLookupKey: PRO_MONTHLY_PRICE_LOOKUP_KEY,
          displayedAmountDollars: PRICING.pro.monthly,
          currency: "usd",
          billingInterval: "month",
          stripePriceId,
        });
        setProMonthlyPriceResolved(true);
      })
      .catch((error: unknown) => {
        if ((error as { name?: unknown })?.name === "AbortError") return;
        setProMonthlyPrice(undefined);
        setProMonthlyPriceUnavailable(true);
        setProMonthlyPriceResolved(false);
      });

    return () => controller.abort();
  }, [isOpen, proMonthlyPriceResolved, subscription]);

  // Auto-close pricing dialog for ultra/team users (pro-plus can still upgrade to ultra)
  React.useEffect(() => {
    if (isOpen && (subscription === "ultra" || subscription === "team")) {
      onClose();
    }
  }, [isOpen, subscription, onClose]);

  React.useEffect(() => {
    if (!isOpen) {
      capturedPricingCtaImpressionRef.current = false;
      return;
    }

    if (
      capturedPricingCtaImpressionRef.current ||
      (subscription === "free" && !proMonthlyPriceResolved)
    ) {
      return;
    }
    capturedPricingCtaImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: "pricing_dialog",
      source: context?.source ?? "plan_cards",
      from_tier: subscription,
      cta_text: "plan_card_buttons",
      ...(context?.reason && { reason: context.reason }),
      ...(context?.limitType && { limit_type: context.limitType }),
    });
  }, [
    context?.limitType,
    context?.reason,
    context?.source,
    isOpen,
    proMonthlyPriceResolved,
    subscription,
  ]);

  const handleBillingChange = (value: "monthly" | "yearly") => {
    setIsYearly(value === "yearly");
  };

  const handleUpgradeClick = async (
    plan:
      | "pro-monthly-plan"
      | "pro-plus-monthly-plan"
      | "ultra-monthly-plan"
      | "pro-yearly-plan"
      | "pro-plus-yearly-plan"
      | "ultra-yearly-plan" = "pro-monthly-plan",
    planName: string,
    price: number,
  ) => {
    if (billingBlocked) return;
    // If user is free, upgrade directly using checkout
    if (subscription === "free") {
      try {
        await handleUpgrade(plan, undefined, undefined, subscription, {
          source: context?.source ?? "plan_card",
          surface: "pricing_dialog",
          reason: context?.reason,
          limit_type: context?.limitType,
        });
        // Don't close dialog on success - let the redirect happen
      } catch (error) {
        console.error("Upgrade failed:", error);
      }
    } else {
      // For existing subscribers, show confirmation dialog with upgrade details
      setPendingUpgrade({ plan, planName, price });
      setShowConfirmDialog(true);
    }
  };

  const handleCloseConfirmDialog = () => {
    setShowConfirmDialog(false);
    setPendingUpgrade(null);
  };

  const handleTeamClick = () => {
    if (!user) {
      navigateToAuth("/signup?intent=pricing", {
        preferSignInForReturningUser: true,
      });
      return;
    }

    // Close pricing while its hash is still active so its URL cleanup runs.
    onClose();

    // Update URL with billing period before opening team dialog
    const url = new URL(window.location.href);
    url.searchParams.set("selectedPlan", isYearly ? "yearly" : "monthly");
    url.hash = "team-pricing-seat-selection";
    window.history.replaceState({}, "", url.toString());
    window.dispatchEvent(new Event("hashchange"));

    setTeamPricingDialogOpen(true);
  };

  // Button configurations for Free plan
  const getFreeButtonConfig = () => {
    if (user && !isCheckingProPlan && subscription === "free") {
      return {
        text: "Your current plan",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    } else if (!user) {
      return {
        text: "Get Started",
        disabled: false,
        className: "",
        variant: "secondary" as const,
        onClick: () =>
          navigateToAuth("/signup", {
            preferSignInForReturningUser: true,
          }),
      };
    } else {
      return {
        text: "Current Plan",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    }
  };

  // Button configurations for Pro plan
  const getProButtonConfig = () => {
    if (user && !isCheckingProPlan && subscription === "pro") {
      return {
        text: "Current Plan",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    } else if (user && subscription === "pro-plus") {
      // Pro+ users can't downgrade to Pro
      return {
        text: "Pro",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    } else if (user) {
      return {
        text:
          subscription === "free" && !isYearly && proMonthlyPriceUnavailable
            ? "Pricing unavailable"
            : (pricingIntentCopy?.proButtonText ?? "Get Pro"),
        disabled:
          upgradeLoading ||
          billingBlocked ||
          (subscription === "free" && !isYearly && !proMonthlyPriceResolved),
        className: "",
        variant: "default" as const,
        onClick: () =>
          handleUpgradeClick(
            isYearly ? "pro-yearly-plan" : "pro-monthly-plan",
            "Pro",
            isYearly ? PRICING.pro.yearly : monthlyProPrice,
          ),
        loading: upgradeLoading,
      };
    } else {
      return {
        text: "Get Pro",
        disabled: false,
        className: "",
        variant: "default" as const,
        onClick: () =>
          navigateToAuth("/signup?intent=pricing", {
            preferSignInForReturningUser: true,
          }),
      };
    }
  };

  // Button configurations for Pro+ plan
  const getProPlusButtonConfig = () => {
    if (user && !isCheckingProPlan && subscription === "pro-plus") {
      return {
        text: "Current Plan",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    } else if (user) {
      const buttonText =
        subscription === "pro"
          ? "Upgrade to Pro+"
          : (pricingIntentCopy?.proPlusButtonText ?? "Get Pro+");
      return {
        text: buttonText,
        disabled: upgradeLoading || billingBlocked,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () =>
          handleUpgradeClick(
            isYearly ? "pro-plus-yearly-plan" : "pro-plus-monthly-plan",
            "Pro+",
            isYearly ? PRICING["pro-plus"].yearly : PRICING["pro-plus"].monthly,
          ),
        loading: upgradeLoading,
      };
    } else {
      return {
        text: "Get Pro+",
        disabled: false,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () =>
          navigateToAuth("/signup?intent=pricing", {
            preferSignInForReturningUser: true,
          }),
      };
    }
  };

  // Button configurations for Ultra plan
  const getUltraButtonConfig = () => {
    if (user && !isCheckingProPlan && subscription === "ultra") {
      return {
        text: "Current Plan",
        disabled: true,
        className: "opacity-50 cursor-not-allowed",
        variant: "secondary" as const,
      };
    } else if (user) {
      return {
        text:
          subscription === "pro" || subscription === "pro-plus"
            ? "Upgrade to Ultra"
            : (pricingIntentCopy?.ultraButtonText ?? "Get Ultra"),
        disabled: upgradeLoading || billingBlocked,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () =>
          handleUpgradeClick(
            isYearly ? "ultra-yearly-plan" : "ultra-monthly-plan",
            "Ultra",
            isYearly ? PRICING.ultra.yearly : PRICING.ultra.monthly,
          ),
        loading: upgradeLoading,
      };
    } else {
      return {
        text: "Get Ultra",
        disabled: false,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () =>
          navigateToAuth("/signup?intent=pricing", {
            preferSignInForReturningUser: true,
          }),
      };
    }
  };

  const freeButtonConfig = getFreeButtonConfig();
  const proButtonConfig = getProButtonConfig();
  const proPlusButtonConfig = getProPlusButtonConfig();
  const ultraButtonConfig = getUltraButtonConfig();

  const hasSubscription = subscription !== "free";
  const showFreePlan =
    !hasSubscription && context?.source !== "regional_subscription_first";

  return (
    <>
      <UpgradeConfirmationDialog
        isOpen={showConfirmDialog}
        onClose={handleCloseConfirmDialog}
        planName={pendingUpgrade?.planName || ""}
        price={pendingUpgrade?.price || 0}
        targetPlan={pendingUpgrade?.plan || ""}
        source={context?.source ?? "plan_card"}
        surface="pricing_dialog"
        reason={context?.reason}
        limitType={context?.limitType}
      />

      <Dialog open={isOpen} onOpenChange={onClose}>
        <DialogContent
          className="!max-w-none !w-screen !h-screen !max-h-none !m-0 !rounded-none !inset-0 !translate-x-0 !translate-y-0 !top-0 !left-0 overflow-y-auto"
          data-testid="modal-account-payment"
          showCloseButton={false}
        >
          <div className="relative grid grid-cols-[1fr_auto_1fr] px-6 py-4 md:pt-[4.5rem] md:pb-6">
            <div></div>
            <div className="my-1 flex flex-col items-center justify-center md:mt-0 md:mb-0">
              <DialogTitle className="text-center text-2xl font-semibold sm:text-3xl">
                {pricingIntentCopy?.title ?? "Upgrade your plan"}
              </DialogTitle>
              {pricingIntentCopy && (
                <p className="text-muted-foreground mt-2 max-w-2xl text-center text-sm">
                  {pricingIntentCopy.description}
                </p>
              )}
            </div>
            <button
              onClick={onClose}
              className="text-foreground justify-self-end opacity-50 transition hover:opacity-75 md:absolute md:end-6 md:top-6"
            >
              <X className="h-6 w-6" />
            </button>
          </div>

          <div className="mt-2 mb-4 flex justify-center px-6">
            <BillingFrequencySelector
              value={isYearly ? "yearly" : "monthly"}
              onChange={handleBillingChange}
              isOpen={isOpen}
            />
          </div>

          <div className="px-6 pb-8">
            {user && (
              <div className="mx-auto mb-6 w-full max-w-[88rem]">
                {billing.isLoading && (
                  <p
                    role="status"
                    className="text-center text-sm text-muted-foreground"
                  >
                    Checking your billing status…
                  </p>
                )}
                {billing.error && !billingReviewRequired && (
                  <div role="status" className="rounded-xl border p-4 text-sm">
                    <p>
                      We couldn’t check your billing status. Try again, or ask
                      your billing administrator for help.
                    </p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-3"
                      disabled={billing.isValidating}
                      onClick={() => void checkBilling().catch(() => {})}
                    >
                      Check again
                    </Button>
                  </div>
                )}
                {(billing.data || billingReviewRequired) && (
                  <BillingRecoveryPanel
                    key={`${user.id}:${organizationId ?? ""}:${billing.data?.latestInvoiceId ?? "review"}`}
                    status={
                      billingReviewRequired
                        ? {
                            ...billing.data,
                            hasActiveSubscription: false,
                            cancelAtPeriodEnd: false,
                            checkoutRequiresReview: true,
                          }
                        : billing.data!
                    }
                    subscription={subscription}
                    surface="pricing_dialog"
                    onCheck={checkBilling}
                  />
                )}
                {billingBlocked && !billing.isLoading && (
                  <p className="mt-3 text-sm text-muted-foreground">
                    Resolve your billing issue before changing plans.
                  </p>
                )}
              </div>
            )}
            <div
              className={cn(
                "mx-auto grid w-full max-w-[88rem] grid-cols-1 gap-6 md:grid-cols-2",
                showFreePlan ? "xl:grid-cols-4" : "xl:grid-cols-3",
              )}
            >
              {showFreePlan && (
                <PlanCard
                  planName="Free"
                  price={0}
                  description="Try HackerAI"
                  features={freeFeatures}
                  buttonText={freeButtonConfig.text}
                  buttonVariant={freeButtonConfig.variant}
                  buttonClassName={freeButtonConfig.className}
                  onButtonClick={freeButtonConfig.onClick}
                  isButtonDisabled={freeButtonConfig.disabled}
                  customClassName="order-2 md:order-none"
                  featureHeader={PLAN_HEADERS.free}
                />
              )}

              <PlanCard
                planName="Pro"
                price={isYearly ? PRICING.pro.yearly : displayedMonthlyProPrice}
                description={
                  pricingIntentCopy?.proDescription ??
                  "For everyday productivity"
                }
                features={proFeatures}
                buttonText={proButtonConfig.text}
                buttonVariant={proButtonConfig.variant}
                buttonClassName={proButtonConfig.className}
                onButtonClick={proButtonConfig.onClick}
                isButtonDisabled={proButtonConfig.disabled}
                isButtonLoading={proButtonConfig.loading}
                customClassName={
                  !hasSubscription ? "order-1 md:order-none" : ""
                }
                featureHeader={PLAN_HEADERS.pro}
              />

              <PlanCard
                planName="Pro+"
                price={
                  isYearly
                    ? PRICING["pro-plus"].yearly
                    : PRICING["pro-plus"].monthly
                }
                description={
                  pricingIntentCopy?.proPlusDescription ??
                  "For power users who need more"
                }
                features={proPlusFeatures}
                buttonText={proPlusButtonConfig.text}
                buttonVariant={proPlusButtonConfig.variant}
                buttonClassName={proPlusButtonConfig.className}
                onButtonClick={proPlusButtonConfig.onClick}
                isButtonDisabled={proPlusButtonConfig.disabled}
                isButtonLoading={proPlusButtonConfig.loading}
                customClassName="order-3 border-[#CFCEFC] bg-[#F5F5FF] dark:bg-[#282841] dark:border-[#484777] md:order-none"
                badgeText="RECOMMENDED"
                featureHeader={PLAN_HEADERS["pro-plus"]}
              />

              <PlanCard
                planName="Ultra"
                price={isYearly ? PRICING.ultra.yearly : PRICING.ultra.monthly}
                description={
                  pricingIntentCopy?.ultraDescription ??
                  "Get the most out of HackerAI"
                }
                features={ultraFeatures}
                buttonText={ultraButtonConfig.text}
                buttonVariant={ultraButtonConfig.variant}
                buttonClassName={ultraButtonConfig.className}
                onButtonClick={ultraButtonConfig.onClick}
                isButtonDisabled={ultraButtonConfig.disabled}
                isButtonLoading={ultraButtonConfig.loading}
                customClassName="order-4 md:order-none"
                featureHeader={PLAN_HEADERS.ultra}
              />
            </div>

            {!hasSubscription && (
              <div className="mt-8 flex justify-center">
                <Button
                  variant="secondary"
                  className="rounded-full border border-border bg-background text-foreground hover:bg-muted/60"
                  onClick={handleTeamClick}
                >
                  View Team Plans
                </Button>
              </div>
            )}

            <p className="text-muted-foreground mx-auto mt-8 max-w-[88rem] text-center text-xs">
              Learn how we handle your data on our{" "}
              <a
                href="/trust"
                target="_blank"
                rel="noreferrer"
                className="text-foreground underline underline-offset-2"
              >
                Security &amp; Trust
              </a>{" "}
              page.
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default PricingDialog;
