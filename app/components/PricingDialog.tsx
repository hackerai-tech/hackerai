"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { Loader2, X } from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import { navigateToAuth } from "../hooks/useTauri";
import {
  freeFeatures,
  proFeatures,
  ultraFeatures,
  teamFeatures,
  PRICING,
} from "@/lib/pricing/features";
import BillingFrequencySelector from "./BillingFrequencySelector";
import UpgradeConfirmationDialog from "./UpgradeConfirmationDialog";

interface PricingDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

interface PlanCardProps {
  planName: string;
  price: number;
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
}) => {
  return (
    <div
      className={`border border-border md:min-h-[30rem] md:max-w-96 md:rounded-2xl relative flex flex-1 flex-col justify-center gap-4 rounded-xl px-6 py-6 text-sm bg-background ${customClassName}`}
    >
      <div className="relative flex flex-col mt-0">
        <div className="flex flex-col gap-5">
          <div className="flex items-center gap-2 justify-between text-[28px] font-medium">
            {planName}
            {badgeText ? (
              <Badge
                className={`ms-1 border-none rounded-4xl px-2 pt-1.5 pb-1.25 text-[11px] font-semibold bg-[#DCDBFF] text-[#615EEB] dark:bg-[#444378] dark:text-[#B9B7FF] ${badgeClassName}`}
              >
                {badgeText}
              </Badge>
            ) : null}
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

const PricingDialog: React.FC<PricingDialogProps> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const { subscription, isCheckingProPlan, setTeamPricingDialogOpen } =
    useGlobalState();
  const { upgradeLoading, handleUpgrade } = useUpgrade();
  const [isYearly, setIsYearly] = React.useState(false);
  const [showTeamPlan, setShowTeamPlan] = React.useState(false);
  const [showConfirmDialog, setShowConfirmDialog] = React.useState(false);
  const [pendingUpgrade, setPendingUpgrade] = React.useState<{
    plan: string;
    planName: string;
    price: number;
  } | null>(null);

  // Auto-close pricing dialog for ultra/team users
  React.useEffect(() => {
    if (isOpen && (subscription === "ultra" || subscription === "team")) {
      onClose();
    }
  }, [isOpen, subscription, onClose]);

  const handleBillingChange = (value: "monthly" | "yearly") => {
    setIsYearly(value === "yearly");
  };

  const handleUpgradeClick = async (
    plan:
      | "pro-monthly-plan"
      | "ultra-monthly-plan"
      | "pro-yearly-plan"
      | "ultra-yearly-plan" = "pro-monthly-plan",
    planName: string,
    price: number,
  ) => {
    // If user is free, upgrade directly using checkout
    if (subscription === "free") {
      try {
        await handleUpgrade(plan, undefined, undefined, subscription);
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
      navigateToAuth("/login");
      return;
    }

    // Update URL with billing period before opening team dialog
    const url = new URL(window.location.href);
    url.searchParams.set("selectedPlan", isYearly ? "yearly" : "monthly");
    url.hash = "team-pricing-seat-selection";
    window.history.replaceState({}, "", url.toString());

    onClose(); // Close the pricing dialog
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
        onClick: () => navigateToAuth("/signup"),
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
    } else if (user) {
      return {
        text: "Get Pro",
        disabled: upgradeLoading,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () =>
          handleUpgradeClick(
            isYearly ? "pro-yearly-plan" : "pro-monthly-plan",
            "Pro",
            isYearly ? PRICING.pro.yearly : PRICING.pro.monthly,
          ),
        loading: upgradeLoading,
      };
    } else {
      return {
        text: "Get Pro",
        disabled: false,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: () => navigateToAuth("/login"),
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
        text: subscription === "pro" ? "Upgrade to Ultra" : "Get Ultra",
        disabled: upgradeLoading,
        className: "",
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
        className: "",
        variant: "default" as const,
        onClick: () => navigateToAuth("/login"),
      };
    }
  };

  const freeButtonConfig = getFreeButtonConfig();
  const proButtonConfig = getProButtonConfig();
  const ultraButtonConfig = getUltraButtonConfig();

  const hasSubscription = subscription !== "free";

  return (
    <>
      <UpgradeConfirmationDialog
        isOpen={showConfirmDialog}
        onClose={handleCloseConfirmDialog}
        planName={pendingUpgrade?.planName || ""}
        price={pendingUpgrade?.price || 0}
        targetPlan={pendingUpgrade?.plan || ""}
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
              <DialogTitle className="text-3xl font-semibold">
                Upgrade your plan
              </DialogTitle>
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

          <div className="flex justify-center gap-6 flex-col md:flex-row pb-6">
            {showTeamPlan ? (
              <>
                {/* Show Free Plan if no subscription, Pro Plan if pro subscription */}
                {!hasSubscription ? (
                  <PlanCard
                    planName="Free"
                    price={0}
                    description="Intelligence for everyday tasks"
                    features={freeFeatures}
                    buttonText={freeButtonConfig.text}
                    buttonVariant={freeButtonConfig.variant}
                    buttonClassName={freeButtonConfig.className}
                    onButtonClick={freeButtonConfig.onClick}
                    isButtonDisabled={freeButtonConfig.disabled}
                  />
                ) : subscription === "pro" ? (
                  <PlanCard
                    planName="Pro"
                    price={isYearly ? PRICING.pro.yearly : PRICING.pro.monthly}
                    description="More access to advanced intelligence"
                    features={proFeatures}
                    buttonText={proButtonConfig.text}
                    buttonVariant={proButtonConfig.variant}
                    buttonClassName={proButtonConfig.className}
                    onButtonClick={proButtonConfig.onClick}
                    isButtonDisabled={proButtonConfig.disabled}
                    isButtonLoading={proButtonConfig.loading}
                  />
                ) : null}

                {/* Team Plan */}
                <PlanCard
                  planName="Team"
                  price={isYearly ? PRICING.team.yearly : PRICING.team.monthly}
                  description="Supercharge your team with a secure, collaborative workspace"
                  features={teamFeatures}
                  buttonText={
                    subscription === "pro" ? "Upgrade to Team" : "Get Team"
                  }
                  buttonVariant={"default"}
                  buttonClassName="font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white"
                  onButtonClick={handleTeamClick}
                  isButtonDisabled={false}
                  customClassName="border-[#CFCEFC] bg-[#F5F5FF] dark:bg-[#282841] dark:border-[#484777]"
                  badgeText="RECOMMENDED"
                />
              </>
            ) : (
              <>
                {/* Free Plan - only show if user doesn't have a subscription */}
                {!hasSubscription && (
                  <PlanCard
                    planName="Free"
                    price={0}
                    description="Intelligence for everyday tasks"
                    features={freeFeatures}
                    buttonText={freeButtonConfig.text}
                    buttonVariant={freeButtonConfig.variant}
                    buttonClassName={freeButtonConfig.className}
                    onButtonClick={freeButtonConfig.onClick}
                    isButtonDisabled={freeButtonConfig.disabled}
                  />
                )}

                {/* Pro Plan */}
                <PlanCard
                  planName="Pro"
                  price={isYearly ? PRICING.pro.yearly : PRICING.pro.monthly}
                  description="More access to advanced intelligence"
                  features={proFeatures}
                  buttonText={proButtonConfig.text}
                  buttonVariant={proButtonConfig.variant}
                  buttonClassName={proButtonConfig.className}
                  onButtonClick={proButtonConfig.onClick}
                  isButtonDisabled={proButtonConfig.disabled}
                  isButtonLoading={proButtonConfig.loading}
                  customClassName="border-[#CFCEFC] bg-[#F5F5FF] dark:bg-[#282841] dark:border-[#484777]"
                  badgeText="POPULAR"
                />

                {/* Ultra Plan */}
                <PlanCard
                  planName="Ultra"
                  price={
                    isYearly ? PRICING.ultra.yearly : PRICING.ultra.monthly
                  }
                  description="Full access to the best of HackerAI"
                  features={ultraFeatures}
                  buttonText={ultraButtonConfig.text}
                  buttonVariant={ultraButtonConfig.variant}
                  buttonClassName={ultraButtonConfig.className}
                  isButtonDisabled={ultraButtonConfig.disabled}
                  isButtonLoading={ultraButtonConfig.loading}
                  onButtonClick={ultraButtonConfig.onClick}
                  footerNote="Unlimited subject to abuse guardrails."
                />
              </>
            )}
          </div>

          <div className="flex justify-center pb-8">
            <Button
              variant="secondary"
              className="rounded-full border border-border bg-background text-foreground hover:bg-muted/60"
              onClick={() => setShowTeamPlan((prev) => !prev)}
            >
              {showTeamPlan ? "View Individual Plan" : "View Team Plan"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default PricingDialog;
