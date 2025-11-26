"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { Check, Cloud, Laptop, AlertTriangle, ChevronDown } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useState } from "react";

interface SandboxSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  size?: "sm" | "md";
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
    ...((connections as LocalConnection[] | undefined)?.map((conn) => ({
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

  const selectedOption = options.find((opt) => opt.id === value) || options[0];
  const Icon = selectedOption?.icon || Cloud;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size={size === "md" ? "default" : "sm"}
          disabled={disabled}
          className={
            size === "md"
              ? "h-9 px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
              : "h-7 px-2 gap-1 text-xs font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
          }
        >
          <Icon
            className={size === "md" ? "h-4 w-4 shrink-0" : "h-3 w-3 shrink-0"}
          />
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
          <ChevronDown
            className={
              size === "md" ? "h-4 w-4 ml-1 shrink-0" : "h-3 w-3 ml-1 shrink-0"
            }
          />
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
                  onChange(option.id);
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
            <div className="px-2 py-2 text-xs text-muted-foreground border-t mt-1 pt-2">
              No local connections.{" "}
              <span className="text-foreground">
                Run{" "}
                <code className="bg-muted px-1 rounded">
                  npx @hackerai/local
                </code>
              </span>{" "}
              to enable local execution.
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
