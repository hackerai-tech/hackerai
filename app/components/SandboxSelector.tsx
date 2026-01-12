"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import {
  Check,
  Cloud,
  Laptop,
  AlertTriangle,
  ChevronDown,
  Copy,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { toast } from "sonner";

interface SandboxSelectorProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  size?: "sm" | "md";
  readOnly?: boolean;
}

interface LocalConnection {
  connectionId: string;
  name: string;
  mode: "docker" | "dangerous" | "custom";
  imageName?: string;
  containerId?: string;
  osInfo?: {
    platform: string;
  };
  lastSeen: number;
}

interface ConnectionOption {
  id: string;
  label: string;
  description: string;
  icon: typeof Cloud;
  warning: string | null;
  mode?: "docker" | "dangerous" | "custom";
}

export function SandboxSelector({
  value,
  onChange,
  disabled = false,
  size = "sm",
  readOnly = false,
}: SandboxSelectorProps) {
  const [open, setOpen] = useState(false);

  const connections = useQuery(api.localSandbox.listConnections);

  const options: ConnectionOption[] = [
    {
      id: "e2b",
      label: "Cloud",
      icon: Cloud,
      description: "",
      warning: null,
    },
    ...(connections?.map((conn) => ({
      id: conn.connectionId,
      label: conn.name,
      icon: Laptop,
      description:
        conn.mode === "dangerous"
          ? `Dangerous: ${conn.osInfo?.platform || "unknown"}`
          : conn.mode === "custom"
            ? `Custom: ${conn.imageName || "unknown"}`
            : `Docker: ${conn.containerId?.slice(0, 8) || "unknown"}`,
      warning:
        conn.mode === "dangerous" ? "Direct OS access - no isolation" : null,
      mode: conn.mode,
    })) || []),
  ];

  // Auto-correct stale sandbox preference: if the stored value doesn't match any
  // available option (e.g., local connection was disconnected), reset to "e2b"
  const valueMatchesOption = options.some((opt) => opt.id === value);
  useEffect(() => {
    if (connections !== undefined && !valueMatchesOption && value !== "e2b") {
      onChange?.("e2b");
      toast.info("Local sandbox disconnected. Switched to Cloud.", {
        duration: 5000,
      });
    }
  }, [connections, valueMatchesOption, value, onChange]);

  const selectedOption = options.find((opt) => opt.id === value) || options[0];
  const Icon = selectedOption?.icon || Cloud;

  const buttonClassName =
    size === "md"
      ? "h-9 px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
      : "h-7 px-2 gap-1 text-xs font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink";

  const iconClassName = size === "md" ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0";

  const buttonContent = (
    <>
      <Icon className={iconClassName} />
      <span className="truncate">{selectedOption?.label}</span>
      {selectedOption?.mode === "dangerous" && (
        <AlertTriangle
          className={
            size === "md"
              ? "h-4 w-4 text-yellow-500 shrink-0"
              : "h-3 w-3 text-yellow-500 shrink-0"
          }
        />
      )}
      {!readOnly && (
        <ChevronDown
          className={
            size === "md" ? "h-4 w-4 ml-1 shrink-0" : "h-3 w-3 ml-1 shrink-0"
          }
        />
      )}
    </>
  );

  // Read-only mode: display with tooltip
  if (readOnly) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div
            className={`flex items-center cursor-default text-muted-foreground ${buttonClassName}`}
            aria-label="Sandbox environment for this chat"
          >
            {buttonContent}
          </div>
        </TooltipTrigger>
        <TooltipContent>
          <p>Sandbox environment for this chat</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  // Editable mode: popover selector
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={size === "md" ? "default" : "sm"}
          disabled={disabled}
          className={buttonClassName}
        >
          {buttonContent}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-1" align="start">
        <div className="space-y-0.5">
          <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
            Execution Environment
          </div>
          {options.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.id}
                onClick={() => {
                  onChange?.(option.id);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 p-2 rounded-md text-left transition-colors ${
                  value === option.id
                    ? "bg-accent text-accent-foreground"
                    : "hover:bg-muted"
                }`}
              >
                <OptionIcon className="h-4 w-4 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium truncate">
                      {option.label}
                    </span>
                    {option.mode === "dangerous" && (
                      <AlertTriangle className="h-3 w-3 text-yellow-500 shrink-0" />
                    )}
                  </div>
                  {option.description && (
                    <div className="text-xs text-muted-foreground truncate">
                      {option.description}
                    </div>
                  )}
                  {option.warning && (
                    <div className="text-xs text-yellow-600 dark:text-yellow-400 mt-0.5">
                      {option.warning}
                    </div>
                  )}
                </div>
                {value === option.id && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}
          {connections && connections.length === 0 && (
            <div className="px-2 py-2 border-t mt-1 pt-2 space-y-2">
              <div className="text-xs text-muted-foreground">
                No local connections.
              </div>
              <div className="flex gap-1.5">
                <code className="flex-1 p-2 rounded-md font-mono text-xs bg-zinc-900 dark:bg-zinc-950 text-zinc-300 dark:text-zinc-400 overflow-x-auto">
                  npx @hackerai/local@latest
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  className="shrink-0 h-8 w-8"
                  onClick={() => {
                    navigator.clipboard.writeText("npx @hackerai/local@latest");
                    toast.success("Command copied to clipboard");
                  }}
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
              <div className="text-xs text-muted-foreground">
                Run this command to enable local execution.
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
