"use client";

import {
  Brain,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  Loader2,
  Lock,
  Monitor,
  ShieldAlert,
  Terminal,
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
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useState } from "react";
import { isCodexLocal, type ChatMode, type SelectedModel } from "@/types/chat";
import { isAgentMode } from "@/lib/utils/mode-helpers";
import { useGlobalState } from "@/app/contexts/GlobalState";
import { useIsMobile } from "@/hooks/use-mobile";
import { useTauri } from "@/app/hooks/useTauri";
import { toast } from "sonner";
import { detectPlatform } from "@/app/download/DownloadSection";

import { OpenAIIcon } from "./ModelSelector/icons";
import { CostIndicator } from "./ModelSelector/CostIndicator";
import { checkCodexStatus } from "./ModelSelector/checkCodexStatus";
import {
  ASK_MODEL_OPTIONS,
  AGENT_MODEL_OPTIONS,
  CODEX_LOCAL_OPTIONS,
  getDefaultModelForMode,
  type ModelOption,
} from "./ModelSelector/constants";

// ── Shared sub-components ──────────────────────────────────────────

interface ModelSelectorProps {
  value: SelectedModel;
  onChange: (model: SelectedModel) => void;
  mode: ChatMode;
  locked?: boolean;
}

const AutoToggle = ({
  isAuto,
  onToggle,
  mobile = false,
}: {
  isAuto: boolean;
  onToggle: (checked: boolean) => void;
  mobile?: boolean;
}) => {
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onToggle(!isAuto);
    }
  };

  return (
    <div
      role="button"
      onClick={() => onToggle(!isAuto)}
      onKeyDown={handleKeyDown}
      className={`group w-full flex items-center gap-2.5 px-2.5 rounded-lg text-left transition-colors select-none cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring hover:bg-muted/50 ${
        mobile ? "py-2.5" : "py-2"
      }`}
      aria-label="Toggle auto model selection"
      tabIndex={0}
    >
      <div className="flex-1 min-w-0">
        <span className="text-sm font-medium text-foreground">Auto</span>
        {isAuto && (
          <p className="text-xs text-muted-foreground leading-snug mt-0.5">
            Balanced quality and speed, recommended for most tasks
          </p>
        )}
      </div>
      <Switch
        checked={isAuto}
        onCheckedChange={onToggle}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
        aria-label="Auto model selection"
        className="shrink-0"
      />
    </div>
  );
};

const ModelOptionButton = ({
  option,
  isSelected,
  isFreeUser,
  onSelect,
  mobile = false,
}: {
  option: ModelOption;
  isSelected: boolean;
  isFreeUser: boolean;
  onSelect: (option: ModelOption) => void;
  mobile?: boolean;
}) => (
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
        {option.censored && (
          <Tooltip>
            <TooltipTrigger asChild>
              <ShieldAlert className="h-3 w-3 text-amber-500/70 shrink-0 cursor-default" />
            </TooltipTrigger>
            <TooltipContent
              side="right"
              sideOffset={4}
              className="text-xs px-2 py-1"
            >
              More restricted content policy
            </TooltipContent>
          </Tooltip>
        )}
        {option.id !== "auto" && !option.localProvider && (
          <CostIndicator modelId={option.id} />
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

// ── Codex submenu ──────────────────────────────────────────────────

const DesktopDownloadPrompt = () => {
  const detectedPlatform = detectPlatform();
  return (
    <div className="p-3">
      <div className="flex items-center justify-center rounded-md border bg-gradient-to-b from-muted/50 to-muted py-4 mb-3">
        <Monitor className="h-8 w-8 text-muted-foreground/70" />
      </div>
      <h4 className="text-sm font-semibold mb-1">Desktop App Required</h4>
      <p className="text-xs text-muted-foreground mb-3">
        Codex models run locally on your machine. Download the desktop app to
        use them.
      </p>
      <Button asChild size="sm" className="w-full">
        <a
          href={
            detectedPlatform?.platform === "unknown"
              ? "/download"
              : detectedPlatform?.downloadUrl || "/download"
          }
        >
          <Download className="h-4 w-4 mr-1.5" />
          {detectedPlatform && detectedPlatform.platform !== "unknown"
            ? `Download for ${detectedPlatform.displayName}`
            : "Download desktop app"}
        </a>
      </Button>
    </div>
  );
};

const CodexSubMenu = ({
  codexOptions,
  value,
  onSelect,
  isTauri = false,
  mobile = false,
  compact = false,
}: {
  codexOptions: ModelOption[];
  value: SelectedModel;
  onSelect: (option: ModelOption) => void;
  isTauri?: boolean;
  mobile?: boolean;
  compact?: boolean;
}) => {
  const [subOpen, setSubOpen] = useState(false);
  const hasCodexSelected = codexOptions.some((o) => o.id === value);

  const triggerButton = compact ? (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setSubOpen(true)}
      className="h-7 px-2 gap-1 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
    >
      <OpenAIIcon className="h-3 w-3 shrink-0" />
      <span className="truncate">
        {codexOptions.find((o) => o.id === value)?.label || "Codex"}
      </span>
      <ChevronDown className="h-3 w-3 ml-0.5 shrink-0" />
    </Button>
  ) : (
    <button
      type="button"
      onClick={mobile ? () => setSubOpen(true) : undefined}
      className={`group w-full flex items-center gap-2.5 px-2.5 rounded-lg text-left transition-colors select-none cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring ${
        mobile ? "py-2.5" : "py-1.5"
      } ${hasCodexSelected ? "bg-accent" : "hover:bg-muted/50 active:bg-muted/50"}`}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span
            className={`text-sm transition-colors ${
              hasCodexSelected
                ? "text-accent-foreground"
                : "text-muted-foreground group-hover:text-foreground"
            }`}
          >
            <OpenAIIcon className="h-3.5 w-3.5 inline-block mr-1.5 -mt-0.5" />
            Codex
          </span>
        </div>
      </div>
      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover:text-foreground transition-colors" />
    </button>
  );

  const subContent = isTauri ? (
    <div className="flex flex-col gap-px">
      {codexOptions.map((option) => (
        <ModelOptionButton
          key={option.id}
          option={option}
          isSelected={value === option.id}
          isFreeUser={false}
          onSelect={(opt) => {
            onSelect(opt);
            setSubOpen(false);
          }}
          mobile={mobile}
        />
      ))}
    </div>
  ) : (
    <DesktopDownloadPrompt />
  );

  if (mobile) {
    return (
      <>
        {triggerButton}
        <Sheet open={subOpen} onOpenChange={setSubOpen}>
          <SheetContent
            side="bottom"
            className="rounded-t-2xl px-3 pb-8 pt-0 overscroll-contain"
          >
            <SheetHeader className="pb-1 pt-4">
              <SheetTitle className="text-base">
                {isTauri ? "Select Codex Model" : "Codex"}
              </SheetTitle>
              <SheetDescription className="sr-only">
                {isTauri ? "Choose a Codex model" : "Desktop app required"}
              </SheetDescription>
            </SheetHeader>
            {subContent}
          </SheetContent>
        </Sheet>
      </>
    );
  }

  if (compact) {
    return (
      <Popover open={subOpen} onOpenChange={setSubOpen}>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent
          className="w-[220px] p-1.5 rounded-xl"
          side="bottom"
          align="start"
          sideOffset={4}
        >
          {subContent}
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div
      onMouseEnter={() => setSubOpen(true)}
      onMouseLeave={() => setSubOpen(false)}
    >
      <Popover open={subOpen} onOpenChange={setSubOpen}>
        <PopoverTrigger asChild>{triggerButton}</PopoverTrigger>
        <PopoverContent
          className="w-[220px] p-1.5 rounded-xl"
          side="right"
          align="start"
          sideOffset={8}
          onMouseEnter={() => setSubOpen(true)}
          onMouseLeave={() => setSubOpen(false)}
        >
          {subContent}
        </PopoverContent>
      </Popover>
    </div>
  );
};

// ── Model option list ──────────────────────────────────────────────

const ModelOptionList = ({
  options,
  codexOptions,
  value,
  isAuto,
  isFreeUser,
  isTauri = false,
  onAutoToggle,
  onSelect,
  onClose,
  mobile = false,
}: {
  options: ModelOption[];
  codexOptions: ModelOption[];
  value: SelectedModel;
  isAuto: boolean;
  isFreeUser: boolean;
  isTauri?: boolean;
  onAutoToggle: (checked: boolean) => void;
  onSelect: (option: ModelOption) => void;
  onClose: () => void;
  mobile?: boolean;
}) => (
  <div className="flex flex-col gap-px">
    {isFreeUser ? (
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
    ) : (
      <AutoToggle isAuto={isAuto} onToggle={onAutoToggle} mobile={mobile} />
    )}

    {(!isAuto || isFreeUser) && (
      <>
        {!isFreeUser && <div className="my-1 border-b border-border/50" />}
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
                    mobile={mobile}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent
                side="right"
                sideOffset={12}
                className="bg-popover text-popover-foreground border border-border shadow-lg rounded-xl px-4 py-3 max-w-[220px] [&_svg]:!hidden"
              >
                <p className="text-sm font-semibold text-foreground leading-snug">
                  Access the top AI models
                </p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  Access the latest AI models from OpenAI, Anthropic (Claude)
                  and more by{" "}
                  <a
                    href="#pricing"
                    onClick={() => onClose()}
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

        {codexOptions.length > 0 && (
          <>
            <div className="my-1 border-b border-border/50" />
            <CodexSubMenu
              codexOptions={codexOptions}
              value={value}
              onSelect={onSelect}
              isTauri={isTauri}
              mobile={mobile}
            />
          </>
        )}
      </>
    )}
  </div>
);

// ── Main component ─────────────────────────────────────────────────

export function ModelSelector({
  value,
  onChange,
  mode,
  locked,
}: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const [codexDialog, setCodexDialog] = useState<{
    open: boolean;
    title: string;
    description: string;
    command: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);
  const { subscription } = useGlobalState();
  const isMobile = useIsMobile();
  const { isTauri } = useTauri();

  const isAuto = value === "auto";
  const isFreeUser = subscription === "free";
  const options = isAgentMode(mode) ? AGENT_MODEL_OPTIONS : ASK_MODEL_OPTIONS;
  const codexOptions = CODEX_LOCAL_OPTIONS;
  const allOptions = [...options, ...codexOptions];

  const effectiveValue = isAuto ? getDefaultModelForMode(mode) : value;
  const selected =
    allOptions.find((opt) => opt.id === effectiveValue) ?? options[0];

  const triggerLabel = isFreeUser ? "Model" : isAuto ? "Auto" : selected.label;

  const handleAutoToggle = (checked: boolean) => {
    if (isFreeUser) {
      window.location.hash = "pricing";
      setOpen(false);
      return;
    }
    onChange(checked ? "auto" : getDefaultModelForMode(mode));
  };

  const handleModelSelect = async (option: ModelOption) => {
    if (isFreeUser && !option.localProvider) {
      window.location.hash = "pricing";
      setOpen(false);
      return;
    }

    if (option.localProvider) {
      setOpen(false);
      setChecking(true);

      try {
        const status = await checkCodexStatus();

        if (!status) {
          toast.error("Desktop features unavailable", {
            description: "Could not connect to the desktop app.",
          });
          return;
        }

        if (!status.installed) {
          setCopied(false);
          setCodexDialog({
            open: true,
            title: "Codex CLI Not Found",
            description:
              "Codex CLI (codex) is not installed or not on your PATH. Install it with the command below, then restart the app.",
            command: "npm install -g @openai/codex",
          });
          return;
        }

        if (!status.authenticated) {
          setCopied(false);
          setCodexDialog({
            open: true,
            title: "Codex CLI Not Authenticated",
            description:
              "Codex CLI is installed but not signed in. Run the command below in your terminal to authenticate with your OpenAI account.",
            command: "codex login",
          });
          return;
        }

        onChange(option.id);
      } finally {
        setChecking(false);
      }
      return;
    }

    onChange(option.id);
    setOpen(false);
  };

  const codexSetupDialog = codexDialog && (
    <AlertDialog
      open={codexDialog.open}
      onOpenChange={(open) => {
        if (!open) setCodexDialog(null);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Terminal className="h-5 w-5" />
            {codexDialog.title}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {codexDialog.description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2 rounded-md bg-muted px-3 py-2 font-mono text-sm">
          <code className="flex-1 select-all">{codexDialog.command}</code>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0"
            onClick={() => {
              navigator.clipboard.writeText(codexDialog.command);
              setCopied(true);
              setTimeout(() => setCopied(false), 2000);
            }}
          >
            {copied ? (
              <CheckCheck className="h-3.5 w-3.5 text-green-500" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <AlertDialogFooter>
          <AlertDialogAction>Got it</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );

  // When locked (Codex mid-conversation), show only the Codex submenu trigger
  if (locked && isCodexLocal(value)) {
    return (
      <>
        {codexSetupDialog}

        <div className="shrink min-w-0">
          <CodexSubMenu
            codexOptions={codexOptions}
            value={value}
            onSelect={handleModelSelect}
            isTauri={isTauri}
            mobile={isMobile}
            compact
          />
        </div>
      </>
    );
  }

  const trigger = (
    <Button
      variant="ghost"
      size="sm"
      onClick={isMobile ? () => setOpen(true) : undefined}
      aria-expanded={isMobile ? open : undefined}
      aria-haspopup={isMobile ? "dialog" : undefined}
      disabled={checking}
      className="h-7 px-2 gap-1 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
    >
      {checking ? (
        <Loader2 className="h-3 w-3 shrink-0 animate-spin" />
      ) : (
        isCodexLocal(value) && <OpenAIIcon className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">
        {checking ? "Connecting..." : triggerLabel}
      </span>
      {!checking && <ChevronDown className="h-3 w-3 ml-0.5 shrink-0" />}
    </Button>
  );

  if (isMobile) {
    return (
      <>
        {codexSetupDialog}

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
              codexOptions={codexOptions}
              value={effectiveValue}
              isAuto={isAuto}
              isFreeUser={isFreeUser}
              isTauri={isTauri}
              onAutoToggle={handleAutoToggle}
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
      {codexSetupDialog}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>{trigger}</PopoverTrigger>
        <PopoverContent className="w-[270px] p-1.5 rounded-xl" align="start">
          <ModelOptionList
            options={options}
            codexOptions={codexOptions}
            value={effectiveValue}
            isAuto={isAuto}
            isFreeUser={isFreeUser}
            isTauri={isTauri}
            onAutoToggle={handleAutoToggle}
            onSelect={handleModelSelect}
            onClose={() => setOpen(false)}
          />
        </PopoverContent>
      </Popover>
    </>
  );
}
