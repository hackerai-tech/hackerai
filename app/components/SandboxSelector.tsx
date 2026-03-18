"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Check, Cloud, Laptop, Monitor, ChevronDown, Plus } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useState, useEffect } from "react";
import { toast } from "sonner";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";

interface SandboxSelectorProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  size?: "sm" | "md";
}

interface ConnectionOption {
  id: string;
  label: string;
  shortLabel: string;
  icon: typeof Cloud;
  mode?: "docker" | "dangerous";
}

export function SandboxSelector({
  value,
  onChange,
  disabled = false,
  size = "sm",
}: SandboxSelectorProps) {
  const [open, setOpen] = useState(false);

  const connections = useQuery(api.localSandbox.listConnections);
  const cloudOption: ConnectionOption = {
    id: "e2b",
    label: "Cloud",
    shortLabel: "Cloud",
    icon: Cloud,
  };
  // Desktop option hidden for now
  // const desktopOptions: ConnectionOption[] =
  //   connections
  //     ?.filter((conn) => conn.isDesktop)
  //     .map((conn) => ({
  //       id: conn.connectionId,
  //       label: conn.name,
  //       shortLabel: "Local",
  //       icon: Monitor,
  //       mode: conn.mode,
  //     })) || [];
  const desktopOptions: ConnectionOption[] = [];
  const remoteOptions: ConnectionOption[] =
    connections
      ?.filter((conn) => !conn.isDesktop)
      .map((conn) => ({
        id: conn.connectionId,
        label: conn.osInfo?.hostname || conn.name,
        shortLabel: conn.osInfo?.hostname || conn.name,
        icon: Laptop,
        mode: conn.mode,
      })) || [];
  const options = [cloudOption, /* ...desktopOptions, */ ...remoteOptions];

  // Trigger presence cleanup when dropdown opens
  useEffect(() => {
    if (open) {
      fetch("/api/sandbox/presence").catch(() => {});
    }
  }, [open]);

  // Auto-correct stale sandbox preference
  const valueMatchesOption = options.some((opt) => opt.id === value);
  useEffect(() => {
    if (connections !== undefined && !valueMatchesOption && value !== "e2b") {
      onChange?.("e2b");
      // Only show toast for remote disconnects, not when Desktop is hidden
      const wasHiddenDesktop =
        connections?.some((c) => c.connectionId === value && c.isDesktop) ??
        false;
      if (!wasHiddenDesktop) {
        toast.info("Local sandbox disconnected. Switched to Cloud.", {
          duration: 5000,
        });
      }
    }
  }, [connections, valueMatchesOption, value, onChange]);

  const selectedOption = options.find((opt) => opt.id === value) || options[0];
  const Icon = selectedOption?.icon || Cloud;

  const buttonClassName =
    size === "md"
      ? "h-9 px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
      : "h-7 px-2 gap-1 text-xs font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink";

  const iconClassName = size === "md" ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={size === "md" ? "default" : "sm"}
          disabled={disabled}
          className={buttonClassName}
        >
          <Icon className={iconClassName} />
          <span className="truncate">{selectedOption?.shortLabel}</span>
          <ChevronDown
            className={
              size === "md" ? "h-4 w-4 ml-1 shrink-0" : "h-3 w-3 ml-1 shrink-0"
            }
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[240px] p-1" align="start">
        <div className="space-y-0.5">
          <button
            key={cloudOption.id}
            onClick={() => {
              onChange?.(cloudOption.id);
              setOpen(false);
            }}
            className={`w-full flex items-center gap-2.5 p-2 rounded-md text-left transition-colors ${
              value === cloudOption.id
                ? "bg-accent text-accent-foreground"
                : "hover:bg-muted"
            }`}
          >
            <Cloud className="h-4 w-4 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium truncate">
                {cloudOption.label}
              </div>
            </div>
            {value === cloudOption.id && <Check className="h-4 w-4 shrink-0" />}
          </button>

          {/* Desktop option hidden for now
          {desktopOptions.map((option) => {
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
                  <div className="text-sm font-medium truncate">
                    {option.label}
                  </div>
                </div>
                {value === option.id && (
                  <Check className="h-4 w-4 shrink-0" />
                )}
              </button>
            );
          })}
          */}

          <div className="border-t mt-1 pt-1">
            <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">
              Remote control
            </div>
            {remoteOptions.map((option) => {
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
                    <div className="text-sm font-medium truncate">
                      {option.label}
                    </div>
                  </div>
                  {value === option.id && (
                    <Check className="h-4 w-4 shrink-0" />
                  )}
                </button>
              );
            })}
            <button
              onClick={() => {
                setOpen(false);
                openSettingsDialog("Remote Control");
              }}
              className="w-full flex items-center gap-2.5 p-2 rounded-md text-left text-sm hover:bg-muted transition-colors"
            >
              <Plus className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="flex-1">Add remote control</span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
