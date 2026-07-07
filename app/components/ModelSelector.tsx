"use client";

import { Brain, Check, ChevronDown, ChevronRight, Lock } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useState } from "react";
import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  canUseExtraUsage,
  canUseMaxModel,
  normalizeMaxModelForSubscription,
  normalizeSelectedModelForSubscription,
  type ChatMode,
  type SelectedModel,
  type SubscriptionTier,
} from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

import { CostIndicator } from "./ModelSelector/CostIndicator";
import {
  ASK_MODEL_OPTIONS,
  AGENT_MODEL_OPTIONS,
  getDefaultModelForMode,
  type ModelOption,
} from "./ModelSelector/constants";

// ── Shared sub-components ──────────────────────────────────────────

interface ModelSelectorProps {
  value: SelectedModel;
  onChange: (model: SelectedModel) => void;
  mode: ChatMode;
}

const AUTO_MODEL_DESCRIPTION =
  "Balanced quality and speed, recommended for most tasks";

const isMaxModel = (model: SelectedModel): boolean => model === "hackerai-max";

const canUnlockMaxWithExtraUsage = (subscription: SubscriptionTier): boolean =>
  subscription !== "free" && subscription !== "ultra";

const isModelLockedForSubscription = (
  subscription: SubscriptionTier,
  model: SelectedModel,
  extraUsageAvailable = false,
): boolean =>
  subscription === "free" ||
  (isMaxModel(model) && !canUseMaxModel(subscription, { extraUsageAvailable }));

const getLockedModelCta = (
  model: SelectedModel,
  subscription: SubscriptionTier,
): string => {
  if (isMaxModel(model) && canUnlockMaxWithExtraUsage(subscription)) {
    return "Manage Extra Usage";
  }
  return isMaxModel(model) ? "Upgrade to Ultra" : "Upgrade your plan";
};

const getLockedModelAnnouncement = (
  model: SelectedModel,
  subscription: SubscriptionTier,
): string =>
  `${getLockedModelCta(model, subscription)}${
    isMaxModel(model) ? " for Max mode" : " to unlock"
  }`;

const handleLockedModelCta = ({
  mobile,
  option,
  subscription,
}: {
  mobile: boolean;
  option: ModelOption;
  subscription: SubscriptionTier;
}) => {
  const maxLocked = isMaxModel(option.id);
  if (maxLocked && canUnlockMaxWithExtraUsage(subscription)) {
    openSettingsDialog("Extra Usage");
    return;
  }

  redirectToPricing({
    surface: mobile ? "model_selector_mobile" : "model_selector",
    source: maxLocked ? "max_model_gate" : "locked_model_option",
    from_tier: subscription,
    cta_text: getLockedModelCta(option.id, subscription),
  });
};

const AutoOptionButton = ({
  isSelected,
  onSelect,
  mobile = false,
}: {
  isSelected: boolean;
  onSelect: () => void;
  mobile?: boolean;
}) => (
  <button
    type="button"
    onClick={onSelect}
    aria-pressed={isSelected}
    className={`group w-full flex items-center gap-2.5 px-2.5 rounded-lg text-left transition-colors select-none cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
      mobile ? "py-2.5" : "py-2"
    } ${isSelected ? "bg-accent" : "hover:bg-muted/50 active:bg-muted/50"}`}
  >
    <div className="flex-1 min-w-0">
      <span
        className={`text-sm font-medium transition-colors ${
          isSelected
            ? "text-accent-foreground"
            : "text-muted-foreground group-hover:text-foreground"
        }`}
      >
        Auto
      </span>
      <p className="text-xs text-muted-foreground leading-snug mt-0.5">
        {AUTO_MODEL_DESCRIPTION}
      </p>
    </div>
    {isSelected ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
  </button>
);

const ModelOptionButton = ({
  option,
  isSelected,
  isLocked,
  subscription,
  onSelect,
  mobile = false,
}: {
  option: ModelOption;
  isSelected: boolean;
  isLocked: boolean;
  subscription: SubscriptionTier;
  onSelect: (option: ModelOption) => void;
  mobile?: boolean;
}) => {
  const button = (
    <button
      type="button"
      onClick={() => onSelect(option)}
      aria-pressed={isSelected}
      aria-label={
        isLocked
          ? `${option.label}. ${getLockedModelAnnouncement(
              option.id,
              subscription,
            )}.`
          : undefined
      }
      className={`group w-full flex items-center gap-2.5 px-2.5 rounded-lg text-left transition-colors select-none cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        mobile ? "py-2.5" : "py-1.5"
      } ${isSelected ? "bg-accent" : "hover:bg-muted/50 active:bg-muted/50"}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-sm transition-colors ${
              isSelected
                ? "text-accent-foreground"
                : "text-muted-foreground group-hover:text-foreground"
            }`}
          >
            {option.label}
          </span>
          {option.thinking && (
            <Brain className="h-3 w-3 text-muted-foreground/60" />
          )}
          {option.id !== "auto" && <CostIndicator modelId={option.id} />}
        </div>
      </div>
      {isLocked ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
      ) : isSelected ? (
        <Check className="h-3.5 w-3.5 shrink-0" />
      ) : null}
    </button>
  );

  // Locked options get the upgrade tooltip from the parent ModelOptionList; skipping
  // the inner one prevents a flicker where both nested tooltips race to render.
  if (mobile || !option.description || isLocked) return button;

  return (
    <Tooltip delayDuration={150}>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={12}
        align="start"
        className="bg-popover text-popover-foreground border border-border shadow-lg rounded-xl px-4 py-3 max-w-[240px] space-y-1.5 [&_svg]:!hidden"
      >
        <p className="text-sm font-semibold text-foreground leading-snug">
          {option.description}
        </p>
        {option.poweredBy && (
          <p className="text-xs text-muted-foreground">
            Powered by {option.poweredBy}
          </p>
        )}
      </TooltipContent>
    </Tooltip>
  );
};

// ── Model option list ──────────────────────────────────────────────

const ModelOptionList = ({
  options,
  value,
  isAuto,
  isFreeUser,
  subscription,
  maxModelExtraUsageAvailable,
  onAutoSelect,
  onSelect,
  onClose,
  mobile = false,
}: {
  options: ModelOption[];
  value: SelectedModel;
  isAuto: boolean;
  isFreeUser: boolean;
  subscription: SubscriptionTier;
  maxModelExtraUsageAvailable: boolean;
  onAutoSelect: () => void;
  onSelect: (option: ModelOption) => void;
  onClose: () => void;
  mobile?: boolean;
}) => (
  <div className="flex flex-col gap-px">
    {isFreeUser ? (
      <>
        <a
          href="#pricing"
          onClick={(event) => {
            event.preventDefault();
            onClose();
            redirectToPricing({
              surface: mobile ? "model_selector_mobile" : "model_selector",
              source: "model_gate",
              from_tier: "free",
              cta_text: "Get access to paid models",
            });
          }}
          className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-2 transition-colors hover:bg-primary/20 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="text-sm font-semibold text-foreground">
            Get access to paid models
          </span>
          <ChevronRight className="h-4 w-4 text-primary shrink-0" />
        </a>
        <div className="my-1.5 border-b border-border/50" />
      </>
    ) : (
      <>
        <AutoOptionButton
          isSelected={isAuto}
          onSelect={onAutoSelect}
          mobile={mobile}
        />
        <div className="my-1 border-b border-border/50" />
      </>
    )}

    {options.map((option) => {
      const isSelected = value === option.id;
      const isLocked = isModelLockedForSubscription(
        subscription,
        option.id,
        maxModelExtraUsageAvailable,
      );
      const showUpgradeTooltip = isLocked && !mobile;

      if (!showUpgradeTooltip) {
        return (
          <div key={option.id}>
            <ModelOptionButton
              option={option}
              isSelected={isSelected}
              isLocked={isLocked}
              subscription={subscription}
              onSelect={onSelect}
              mobile={mobile}
            />
          </div>
        );
      }

      return (
        <Tooltip key={option.id}>
          <TooltipTrigger asChild>
            <div>
              <ModelOptionButton
                option={option}
                isSelected={isSelected}
                isLocked={isLocked}
                subscription={subscription}
                onSelect={onSelect}
                mobile={mobile}
              />
            </div>
          </TooltipTrigger>
          <TooltipContent
            side="right"
            sideOffset={12}
            align="start"
            className="bg-popover text-popover-foreground border border-border shadow-lg rounded-xl px-4 py-3 max-w-[240px] space-y-1.5 [&_svg]:!hidden"
          >
            {option.description ? (
              <p className="text-sm font-semibold text-foreground leading-snug">
                {option.description}
              </p>
            ) : (
              <p className="text-sm font-semibold text-foreground leading-snug">
                {option.label}
              </p>
            )}
            {option.poweredBy && (
              <p className="text-xs text-muted-foreground">
                Powered by {option.poweredBy}
              </p>
            )}
            <p className="text-xs text-muted-foreground leading-relaxed pt-1">
              <a
                href={
                  isMaxModel(option.id) &&
                  canUnlockMaxWithExtraUsage(subscription)
                    ? "#extra-usage"
                    : "#pricing"
                }
                onClick={(event) => {
                  event.preventDefault();
                  onClose();
                  handleLockedModelCta({
                    mobile,
                    option,
                    subscription,
                  });
                }}
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                tabIndex={0}
              >
                {getLockedModelCta(option.id, subscription)}
              </a>
              {isMaxModel(option.id) ? " for Max mode." : " to unlock."}
            </p>
          </TooltipContent>
        </Tooltip>
      );
    })}
  </div>
);

// ── Main component ─────────────────────────────────────────────────

export function ModelSelector({ value, onChange, mode }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const { subscription } = useGlobalState();
  const isMobile = Boolean(useIsMobile());

  const isFreeUser = subscription === "free";
  const shouldCheckPersonalExtraUsage =
    subscription === "pro" || subscription === "pro-plus";
  const userCustomization = useQuery(
    api.userCustomization.getUserCustomization,
    shouldCheckPersonalExtraUsage ? undefined : "skip",
  );
  const extraUsageSettings = useQuery(
    api.extraUsage.getExtraUsageSettings,
    shouldCheckPersonalExtraUsage ? undefined : "skip",
  );
  const monthlyRemainingDollars =
    extraUsageSettings?.monthlyCapDollars === undefined
      ? undefined
      : Math.max(
          0,
          extraUsageSettings.monthlyCapDollars -
            (extraUsageSettings.monthlySpentDollars ?? 0),
        );
  const maxModelExtraUsageAvailable = canUseExtraUsage({
    enabled: userCustomization?.extra_usage_enabled ?? false,
    balanceDollars: extraUsageSettings?.balanceDollars,
    autoReloadEnabled: extraUsageSettings?.autoReloadEnabled,
    monthlyRemainingDollars,
  });
  const subscriptionValue = normalizeSelectedModelForSubscription(
    value,
    subscription,
  );
  const displayValue =
    normalizeMaxModelForSubscription(subscriptionValue, subscription, {
      extraUsageAvailable: maxModelExtraUsageAvailable,
    }) ?? "auto";
  const isAuto = displayValue === "auto";

  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;

  const effectiveValue = isAuto ? getDefaultModelForMode(mode) : displayValue;
  const selected =
    options.find((opt) => opt.id === effectiveValue) ?? options[0];

  const isFreeAgent = isFreeUser && isAgentMode(mode);
  const triggerLabel = isFreeAgent
    ? "Auto"
    : isFreeUser
      ? "Model"
      : isAuto
        ? "Auto"
        : selected.label;

  const handleAutoSelect = () => {
    onChange("auto");
    setOpen(false);
  };

  const applyModelChoice = (option: ModelOption) => {
    onChange(option.id);
    setOpen(false);
  };

  const handleModelSelect = (option: ModelOption) => {
    if (
      isModelLockedForSubscription(
        subscription,
        option.id,
        maxModelExtraUsageAvailable,
      )
    ) {
      setOpen(false);
      handleLockedModelCta({
        mobile: isMobile,
        option,
        subscription,
      });
      return;
    }

    applyModelChoice(option);
  };

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      onClick={isMobile ? () => setOpen(true) : undefined}
      aria-expanded={isMobile ? open : undefined}
      aria-haspopup={isMobile ? "dialog" : undefined}
      className="h-7 px-2 gap-1 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
    >
      <span className="truncate">{triggerLabel}</span>
      <ChevronDown className="h-3 w-3 ml-0.5 shrink-0" />
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        <Sheet open={open} onOpenChange={setOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl px-3 pb-8 pt-0 overscroll-contain"
          >
            <SheetHeader className="pb-1 pt-4">
              <SheetTitle className="text-base">Select Model</SheetTitle>
              <SheetDescription className="sr-only">
                Choose a model
              </SheetDescription>
            </SheetHeader>
            <ModelOptionList
              options={options}
              value={displayValue}
              isAuto={isAuto}
              isFreeUser={isFreeUser}
              subscription={subscription}
              maxModelExtraUsageAvailable={maxModelExtraUsageAvailable}
              onAutoSelect={handleAutoSelect}
              onSelect={handleModelSelect}
              onClose={() => setOpen(false)}
              mobile
            />
          </SheetContent>
        </Sheet>
      </>
    );
  }

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-[270px] p-1.5 rounded-xl" align="start">
          <ModelOptionList
            options={options}
            value={displayValue}
            isAuto={isAuto}
            isFreeUser={isFreeUser}
            subscription={subscription}
            maxModelExtraUsageAvailable={maxModelExtraUsageAvailable}
            onAutoSelect={handleAutoSelect}
            onSelect={handleModelSelect}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
