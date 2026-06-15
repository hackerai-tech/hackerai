"use client";

import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  Lock,
} from "lucide-react";
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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState } from "react";
import type { ChatMode, SelectedModel, SubscriptionTier } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";

import { CostIndicator } from "./ModelSelector/CostIndicator";
import {
  ASK_MODEL_OPTIONS,
  AGENT_MODEL_OPTIONS,
  getDefaultModelForMode,
  type ModelOption,
} from "./ModelSelector/constants";
import {
  dismissHighCostModelUsageNotice,
  isHighCostModelUsageNoticeDismissed,
} from "@/lib/utils/pro-max-notice-cookie";

// ── Shared sub-components ──────────────────────────────────────────

interface ModelSelectorProps {
  value: SelectedModel;
  onChange: (model: SelectedModel) => void;
  mode: ChatMode;
}

const AUTO_MODEL_DESCRIPTION =
  "Balanced quality and speed, recommended for most tasks";

const shouldWarnForPaidHighCostModel = (
  subscription: SubscriptionTier,
  model: SelectedModel,
): boolean =>
  subscription !== "free" &&
  (model === "hackerai-max" || model === "hackerai-pro");

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
  isFreeUser,
  onSelect,
  mode,
  mobile = false,
}: {
  option: ModelOption;
  isSelected: boolean;
  isFreeUser: boolean;
  onSelect: (option: ModelOption) => void;
  mode: ChatMode;
  mobile?: boolean;
}) => {
  const button = (
    <button
      type="button"
      onClick={() => onSelect(option)}
      aria-pressed={isSelected}
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
          {option.id !== "auto" && (
            <CostIndicator modelId={option.id} mode={mode} />
          )}
        </div>
      </div>
      {isFreeUser ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
      ) : isSelected ? (
        <Check className="h-3.5 w-3.5 shrink-0" />
      ) : null}
    </button>
  );

  // Free users get the upgrade tooltip from the parent ModelOptionList; skipping
  // the inner one prevents a flicker where both nested tooltips race to render.
  if (mobile || !option.description || isFreeUser) return button;

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
  mode,
  onAutoSelect,
  onSelect,
  onClose,
  mobile = false,
}: {
  options: ModelOption[];
  value: SelectedModel;
  isAuto: boolean;
  isFreeUser: boolean;
  mode: ChatMode;
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
              cta_text: "Get access to the top AI models",
            });
          }}
          className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-2 transition-colors hover:bg-primary/20 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="text-sm font-semibold text-foreground">
            Get access to the top AI models
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
      const showUpgradeTooltip = isFreeUser && !mobile;

      if (!showUpgradeTooltip) {
        return (
          <div key={option.id}>
            <ModelOptionButton
              option={option}
              isSelected={isSelected}
              isFreeUser={isFreeUser}
              onSelect={onSelect}
              mode={mode}
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
                isFreeUser={isFreeUser}
                onSelect={onSelect}
                mode={mode}
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
                href="#pricing"
                onClick={(event) => {
                  event.preventDefault();
                  onClose();
                  redirectToPricing({
                    surface: mobile
                      ? "model_selector_mobile"
                      : "model_selector",
                    source: "locked_model_tooltip",
                    from_tier: "free",
                    cta_text: "Upgrade your plan",
                  });
                }}
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                tabIndex={0}
              >
                Upgrade your plan
              </a>{" "}
              to unlock.
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
  const [pendingHighCostNotice, setPendingHighCostNotice] =
    useState<ModelOption | null>(null);
  const { subscription } = useGlobalState();
  const isMobile = useIsMobile();

  const isAuto = value === "auto";
  const isFreeUser = subscription === "free";

  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;

  const effectiveValue = isAuto ? getDefaultModelForMode(mode) : value;
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
    if (isFreeUser) {
      setOpen(false);
      redirectToPricing({
        surface: isMobile ? "model_selector_mobile" : "model_selector",
        source: "locked_model_option",
        from_tier: "free",
        cta_text: option.label,
      });
      return;
    }

    if (
      shouldWarnForPaidHighCostModel(subscription, option.id) &&
      !isHighCostModelUsageNoticeDismissed()
    ) {
      setOpen(false);
      setPendingHighCostNotice(option);
      return;
    }

    applyModelChoice(option);
  };

  const handleDismissHighCostNotice = () => {
    setPendingHighCostNotice(null);
  };

  const handleConfirmHighCostModel = () => {
    if (!pendingHighCostNotice) return;
    dismissHighCostModelUsageNotice();
    applyModelChoice(pendingHighCostNotice);
    setPendingHighCostNotice(null);
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

  const usageLabel =
    subscription === "team" ? "your team's usage" : "your usage";

  const highCostUsageNoticeDialog = (
    <AlertDialog
      open={pendingHighCostNotice !== null}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) handleDismissHighCostNotice();
      }}
    >
      <AlertDialogContent
        data-testid="high-cost-model-warning"
        className="sm:max-w-[460px]"
      >
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle className="flex items-center gap-2 text-lg">
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
              <AlertTriangle className="h-4 w-4" />
            </span>
            <span>High-cost model</span>
          </AlertDialogTitle>
          <AlertDialogDescription className="text-left text-sm leading-relaxed text-foreground/80">
            {pendingHighCostNotice?.label ?? "This model"} is powerful, but it
            can use a lot more of {usageLabel} than Standard, and long requests
            can use around $10 of usage.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={handleDismissHighCostNotice}>
            Pick another model
          </AlertDialogCancel>
          <AlertDialogAction onClick={handleConfirmHighCostModel}>
            Use {pendingHighCostNotice?.label ?? "model"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  if (isMobile) {
    return (
      <>
        {trigger}
        {highCostUsageNoticeDialog}
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
              value={value}
              isAuto={isAuto}
              isFreeUser={isFreeUser}
              mode={mode}
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
      {highCostUsageNoticeDialog}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-[270px] p-1.5 rounded-xl" align="start">
          <ModelOptionList
            options={options}
            value={value}
            isAuto={isAuto}
            isFreeUser={isFreeUser}
            mode={mode}
            onAutoSelect={handleAutoSelect}
            onSelect={handleModelSelect}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
