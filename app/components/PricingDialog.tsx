"use client";

import React from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useAuth } from "@workos-inc/authkit-nextjs/components";
import {
  Sparkle,
  Loader2,
  MessagesSquare,
  Brain,
  Clock,
  Upload,
  FlaskConical,
  X,
  SquareTerminal,
} from "lucide-react";
import { useGlobalState } from "../contexts/GlobalState";
import { useUpgrade } from "../hooks/useUpgrade";
import { useIsMobile } from "@/hooks/use-mobile";

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
}) => {
  return (
    <div
      className={`border border-border md:min-h-[30rem] md:max-w-96 md:rounded-2xl relative flex flex-1 flex-col justify-center gap-4 rounded-xl px-6 py-6 text-sm bg-background ${customClassName}`}
    >
      <div className="relative flex flex-col mt-0">
        <div className="flex flex-col gap-5">
          <p className="flex items-center gap-2 justify-between text-[28px] font-medium">
            {planName}
          </p>
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
    </div>
  );
};

const PricingDialog: React.FC<PricingDialogProps> = ({ isOpen, onClose }) => {
  const { user } = useAuth();
  const { hasProPlan, isCheckingProPlan } = useGlobalState();
  const { upgradeLoading, handleUpgrade } = useUpgrade();

  const handleSignIn = () => {
    window.location.href = "/login";
  };

  const handleSignUp = () => {
    window.location.href = "/signup";
  };

  const handleUpgradeClick = async () => {
    try {
      await handleUpgrade();
      // Don't close dialog on success - let the redirect happen
    } catch (error) {
      // Only close on error if needed
      console.error("Upgrade failed:", error);
    }
  };

  // Plan data configuration
  const freeFeatures = [
    { icon: Sparkle, text: "Access to basic AI model" },
    { icon: Clock, text: "Limited and slower responses" },
    { icon: Brain, text: "Basic memory and context" },
  ];

  const proFeatures = [
    { icon: Sparkle, text: "Access to smartest AI model" },
    { icon: MessagesSquare, text: "Expanded messaging" },
    { icon: Upload, text: "Access to file uploads" },
    { icon: SquareTerminal, text: "Agent mode with terminal" },
    { icon: Brain, text: "Expanded memory and context" },
    { icon: FlaskConical, text: "Research preview of new features" },
  ];

  // Button configurations for Free plan
  const getFreeButtonConfig = () => {
    if (user && !isCheckingProPlan && !hasProPlan) {
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
        onClick: handleSignUp,
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
    if (user && !isCheckingProPlan && hasProPlan) {
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
        onClick: handleUpgradeClick,
        loading: upgradeLoading,
      };
    } else {
      return {
        text: "Get Pro",
        disabled: false,
        className: "font-semibold bg-[#615eeb] hover:bg-[#504bb8] text-white",
        variant: "default" as const,
        onClick: handleSignIn,
      };
    }
  };

  const freeButtonConfig = getFreeButtonConfig();
  const proButtonConfig = getProButtonConfig();

  return (
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

        <div className="flex justify-center gap-6 flex-col md:flex-row pb-8">
          {/* Free Plan */}
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

          {/* Pro Plan */}
          <PlanCard
            planName="Pro"
            price={25}
            description="More access to advanced intelligence"
            features={proFeatures}
            buttonText={proButtonConfig.text}
            buttonVariant={proButtonConfig.variant}
            buttonClassName={proButtonConfig.className}
            onButtonClick={proButtonConfig.onClick}
            isButtonDisabled={proButtonConfig.disabled}
            isButtonLoading={proButtonConfig.loading}
            customClassName="border-[#CFCEFC] bg-[#F5F5FF] dark:bg-[#282841] dark:border-[#484777]"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
};

export default PricingDialog;
