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
import type { ChatMode, SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";

interface ModelOption {
  id: SelectedModel;
  label: string;
  thinking?: boolean;
  requiresPro: boolean;
}

const ASK_MODEL_OPTIONS: ModelOption[] = [
  { id: "gemini-3-flash", label: "Gemini 3 Flash", requiresPro: false },
  { id: "grok-4.1", label: "Grok 4.1", requiresPro: true },
  { id: "gemini-3.1-pro", label: "Gemini 3.1 Pro", requiresPro: true },
  { id: "sonnet-4.6", label: "Claude Sonnet 4.6", requiresPro: true },
  { id: "opus-4.6", label: "Claude Opus 4.6", requiresPro: true },
];

const AGENT_MODEL_OPTIONS: ModelOption[] = [
  { id: "kimi-k2.5", label: "Kimi K2.5", thinking: true, requiresPro: false },
  {
    id: "gemini-3-flash",
    label: "Gemini 3 Flash",
    thinking: true,
    requiresPro: true,
  },
  { id: "grok-4.1", label: "Grok 4.1", thinking: true, requiresPro: true },
  {
    id: "gemini-3.1-pro",
    label: "Gemini 3.1 Pro",
    thinking: true,
    requiresPro: true,
  },
  {
    id: "sonnet-4.6",
    label: "Claude Sonnet 4.6",
    thinking: true,
    requiresPro: true,
  },
  {
    id: "opus-4.6",
    label: "Claude Opus 4.6",
    thinking: true,
    requiresPro: true,
  },
  { id: "codex-5.3", label: "Codex 5.3", thinking: true, requiresPro: true },
];

const getDefaultModelForMode = (mode: ChatMode): SelectedModel => {
  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;
  return (options.find((opt) => !opt.requiresPro) ?? options[0]).id;
};

interface ModelSelectorProps {
  value: SelectedModel;
  onChange: (model: SelectedModel) => void;
  mode: ChatMode;
}

interface ModelOptionListProps {
  options: ModelOption[];
  value: SelectedModel;
  isFreeUser: boolean;
  onSelect: (option: ModelOption) => void;
  onClose: () => void;
  mobile?: boolean;
}

const ModelOptionList = ({
  options,
  value,
  isFreeUser,
  onSelect,
  onClose,
  mobile = false,
}: ModelOptionListProps) => (
  <div className="flex flex-col gap-px">
    {isFreeUser && (
      <>
        <a
          href="#pricing"
          onClick={() => onClose()}
          className="flex items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-2 transition-colors hover:bg-primary/20 cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <span className="text-sm font-semibold text-foreground">
            Get access to the top AI models
          </span>
          <ChevronRight className="h-4 w-4 text-primary shrink-0" />
        </a>
        <div className="my-1.5 border-b border-border/50" />
      </>
    )}
    {options.map((option) => {
      const isSelected = value === option.id;
      const showUpgradeTooltip = isFreeUser && !mobile;

      const modelButton = (
        <button
          key={option.id}
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
            </div>
          </div>
          {isFreeUser ? (
            <Lock className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
          ) : isSelected ? (
            <Check className="h-3.5 w-3.5 shrink-0" />
          ) : null}
        </button>
      );

      if (!showUpgradeTooltip) {
        return <div key={option.id}>{modelButton}</div>;
      }

      return (
        <Tooltip key={option.id}>
          <TooltipTrigger asChild>{modelButton}</TooltipTrigger>
          <TooltipContent
            side="right"
            sideOffset={12}
            className="bg-popover text-popover-foreground border border-border shadow-lg rounded-xl px-4 py-3 max-w-[220px] [&_svg]:!hidden"
          >
            <p className="text-sm font-semibold text-foreground leading-snug">
              Access the top AI models
            </p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              Access the latest AI models from OpenAI, Anthropic (Claude) and
              more by{" "}
              <a
                href="#pricing"
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                tabIndex={0}
              >
                upgrading your plan
              </a>{" "}
              today
            </p>
          </TooltipContent>
        </Tooltip>
      );
    })}
  </div>
);

export function ModelSelector({ value, onChange, mode }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const { subscription } = useGlobalState();
  const isMobile = useIsMobile();

  const isFreeUser = subscription === "free";
  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;

  // Map legacy "auto" value to the actual default model for this mode
  const effectiveValue =
    value === "auto" ? getDefaultModelForMode(mode) : value;

  const selected =
    options.find((opt) => opt.id === effectiveValue) ?? options[0];

  const triggerLabel = isFreeUser ? "Model" : selected.label;

  const handleModelSelect = (option: ModelOption) => {
    if (isFreeUser && option.requiresPro) {
      window.location.hash = "pricing";
      setOpen(false);
      return;
    }
    onChange(option.id);
    setOpen(false);
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
            </SheetHeader>
            <ModelOptionList
              options={options}
              value={effectiveValue}
              isFreeUser={isFreeUser}
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      <PopoverContent className="w-[270px] p-1.5 rounded-xl" align="start">
        <ModelOptionList
          options={options}
          value={effectiveValue}
          isFreeUser={isFreeUser}
          onSelect={handleModelSelect}
          onClose={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}
