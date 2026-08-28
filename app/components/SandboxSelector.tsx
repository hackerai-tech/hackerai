"use client";

import {
  Check,
  Cloud,
  Laptop,
  Monitor,
  ChevronDown,
  ChevronRight,
  Plus,
} from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useState, useEffect, useMemo } from "react";
import { toast } from "sonner";
import { openSettingsDialog } from "@/lib/utils/settings-dialog";
import { useTauri } from "@/app/hooks/useTauri";
import { detectPlatform } from "@/app/download/DownloadSection";
import { useGlobalState } from "@/app/contexts/GlobalState";

interface SandboxSelectorProps {
  value: string;
  onChange?: (value: string) => void;
  disabled?: boolean;
  size?: "sm" | "toolbar" | "md";
}

interface ConnectionOption {
  id: string;
  label: string;
  shortLabel: string;
  icon: typeof Cloud;
  disabled?: boolean;
}

export function SandboxSelector({
  value,
  onChange,
  disabled = false,
  size = "sm",
}: SandboxSelectorProps) {
  const [open, setOpen] = useState(false);
  const [connectHovered, setConnectHovered] = useState(false);
  const { isTauri } = useTauri();
  const {
    subscription,
    localConnections: connections,
    desktopBridgeStatus,
  } = useGlobalState();
  const isFreeUser = subscription === "free";

  const detectedPlatform = useMemo(() => {
    if (typeof window === "undefined") return null;
    return detectPlatform();
  }, []);

  const cloudOption: ConnectionOption = {
    id: "e2b",
    label: "Cloud",
    shortLabel: "Cloud",
    icon: Cloud,
  };
  const desktopLabel =
    isTauri && desktopBridgeStatus !== "connected"
      ? desktopBridgeStatus === "connecting"
        ? "Local reconnecting"
        : "Local unavailable"
      : "Local";
  const desktopConnection = connections?.find((conn) => conn.isDesktop);
  const desktopIsSelectable = !isTauri || desktopBridgeStatus === "connected";
  const desktopOptions: ConnectionOption[] = desktopConnection
    ? [
        {
          id: "desktop",
          label: desktopLabel,
          shortLabel: desktopLabel,
          icon: Monitor,
          disabled: !desktopIsSelectable,
        },
      ]
    : [];
  const remoteConnections = useMemo(
    () => connections?.filter((conn) => !conn.isDesktop) ?? [],
    [connections],
  );
  const remoteConnectionIds = useMemo(
    () =>
      remoteConnections
        .map((connection) => connection.connectionId)
        .sort()
        .join(","),
    [remoteConnections],
  );
  const shouldVerifyRemotePresence =
    isTauri &&
    desktopBridgeStatus !== "connected" &&
    remoteConnections.length > 0;
  const remotePresenceRequest = useMemo(
    () => ({
      enabled: shouldVerifyRemotePresence,
      connectionIds: remoteConnectionIds,
    }),
    [remoteConnectionIds, shouldVerifyRemotePresence],
  );
  const [remotePresence, setRemotePresence] = useState<{
    request: typeof remotePresenceRequest;
    onlineConnectionIds: Set<string>;
  } | null>(null);
  const onlineRemoteConnectionIds =
    remotePresence?.request === remotePresenceRequest
      ? remotePresence.onlineConnectionIds
      : null;
  const liveRemoteConnections = useMemo(
    () =>
      shouldVerifyRemotePresence && onlineRemoteConnectionIds
        ? remoteConnections.filter((connection) =>
            onlineRemoteConnectionIds.has(connection.connectionId),
          )
        : remoteConnections,
    [onlineRemoteConnectionIds, remoteConnections, shouldVerifyRemotePresence],
  );
  const remoteOptions: ConnectionOption[] = liveRemoteConnections.map(
    (conn) => ({
      id: conn.connectionId,
      label: conn.osInfo?.hostname || conn.name,
      shortLabel: conn.osInfo?.hostname || conn.name,
      icon: Laptop,
    }),
  );
  const options = [cloudOption, ...desktopOptions, ...remoteOptions];

  // A connected Convex row can briefly exist before the command relay has
  // subscribed. Confirm live Centrifugo presence before automatically choosing
  // a remote runner over a reconnecting embedded bridge.
  useEffect(() => {
    if (!remotePresenceRequest.enabled) return;

    let cancelled = false;
    fetch("/api/sandbox/presence")
      .then((response) => {
        if (!response.ok) throw new Error("Presence check failed");
        return response.json() as Promise<{
          connections?: Array<{ connectionId?: string; online?: boolean }>;
        }>;
      })
      .then((presence) => {
        if (cancelled) return;
        setRemotePresence({
          request: remotePresenceRequest,
          onlineConnectionIds: new Set(
            (presence.connections ?? [])
              .filter(
                (connection) =>
                  connection.online &&
                  typeof connection.connectionId === "string",
              )
              .map((connection) => connection.connectionId as string),
          ),
        });
      })
      .catch(() => {
        // Keep the remote options visible for manual selection, but do not
        // auto-select one without authoritative presence.
      });

    return () => {
      cancelled = true;
    };
  }, [remotePresenceRequest]);

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
      // Free users can't fall back to Cloud — leave preference as-is,
      // the ChatInput effect will switch them to ask mode
      if (isFreeUser) return;

      onChange?.("e2b");
      // Only show toast for remote disconnects, not when Desktop is hidden
      const wasHiddenDesktop = value === "desktop";
      if (!wasHiddenDesktop) {
        toast.info("Local sandbox disconnected. Switched to Cloud.", {
          duration: 5000,
        });
      }
    }
  }, [connections, valueMatchesOption, value, onChange, isFreeUser]);

  // Keep free users on a usable local connection. A stale Desktop presence can
  // outlive the embedded bridge, so prefer a healthy remote runner while the
  // bridge reconnects instead of repeatedly selecting the unavailable bridge.
  useEffect(() => {
    if (!isFreeUser || !connections?.length) return;

    const firstRemote = shouldVerifyRemotePresence
      ? onlineRemoteConnectionIds
        ? liveRemoteConnections[0]
        : undefined
      : remoteConnections[0];
    const preferredLocal =
      desktopConnection && desktopIsSelectable
        ? "desktop"
        : firstRemote?.connectionId;
    if (!preferredLocal) return;

    const desktopUnavailable =
      isTauri && value === "desktop" && !desktopIsSelectable;
    if (value === "e2b" || desktopUnavailable) {
      onChange?.(preferredLocal);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isFreeUser,
    value,
    connections,
    desktopConnection,
    desktopIsSelectable,
    isTauri,
    shouldVerifyRemotePresence,
    onlineRemoteConnectionIds,
    liveRemoteConnections,
    remoteConnections,
  ]);

  const unavailableLocalOption: ConnectionOption | null =
    value !== "e2b" && !valueMatchesOption
      ? {
          id: value,
          label:
            value === "desktop" && desktopBridgeStatus === "connecting"
              ? "Local reconnecting"
              : "Local unavailable",
          shortLabel:
            value === "desktop" && desktopBridgeStatus === "connecting"
              ? "Local reconnecting"
              : value === "desktop" && desktopBridgeStatus === "connected"
                ? "Local"
                : "Local unavailable",
          icon: value === "desktop" ? Monitor : Laptop,
        }
      : null;
  const selectedOption =
    options.find((option) => option.id === value) ??
    unavailableLocalOption ??
    cloudOption;
  const Icon = selectedOption?.icon || Cloud;

  const buttonClassName =
    size === "md"
      ? "h-9 px-3 gap-2 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
      : size === "toolbar"
        ? "h-7 max-w-44 px-2 gap-1 text-sm font-medium rounded-md bg-transparent hover:bg-muted/30 focus-visible:ring-1 min-w-0 shrink"
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
          title={selectedOption?.label}
        >
          <Icon className={iconClassName} />
          <span className="min-w-0 flex-1 truncate text-left">
            {selectedOption?.shortLabel}
          </span>
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
              if (isFreeUser) {
                toast.info("Cloud sandbox requires a Pro plan", {
                  description:
                    "Use a local sandbox or upgrade to Pro for cloud access.",
                });
                return;
              }
              onChange?.(cloudOption.id);
              setOpen(false);
            }}
            className={`w-full flex items-center gap-2.5 p-2 rounded-md text-left transition-colors ${
              isFreeUser
                ? "opacity-60 cursor-not-allowed"
                : value === cloudOption.id
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
            {isFreeUser ? (
              <span className="text-[10px] font-semibold bg-primary/10 text-primary px-1.5 py-0.5 rounded">
                Pro
              </span>
            ) : (
              value === cloudOption.id && <Check className="h-4 w-4 shrink-0" />
            )}
          </button>

          {desktopOptions.map((option) => {
            const OptionIcon = option.icon;
            return (
              <button
                key={option.id}
                disabled={option.disabled}
                onClick={() => {
                  if (option.disabled) return;
                  onChange?.(option.id);
                  setOpen(false);
                }}
                className={`w-full flex items-center gap-2.5 p-2 rounded-md text-left transition-colors ${
                  option.disabled
                    ? "opacity-60 cursor-not-allowed"
                    : value === option.id
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
                {value === option.id && <Check className="h-4 w-4 shrink-0" />}
              </button>
            );
          })}

          {!isTauri && desktopOptions.length === 0 && (
            <Popover open={connectHovered} onOpenChange={setConnectHovered}>
              <PopoverTrigger asChild>
                <button
                  onMouseEnter={() => setConnectHovered(true)}
                  onMouseLeave={() => setConnectHovered(false)}
                  className="w-full flex items-center gap-2.5 p-2 rounded-md text-left transition-colors hover:bg-muted"
                >
                  <Monitor className="h-4 w-4 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">
                      Connect My Computer
                    </div>
                  </div>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </PopoverTrigger>
              <PopoverContent
                side="top"
                sideOffset={8}
                className="w-[240px] p-4"
                onMouseEnter={() => setConnectHovered(true)}
                onMouseLeave={() => setConnectHovered(false)}
              >
                <div className="flex items-center justify-center rounded-md border bg-gradient-to-b from-muted/50 to-muted py-5 mb-3">
                  <Monitor className="h-10 w-10 text-muted-foreground/70" />
                </div>
                <h4 className="text-sm font-semibold mb-1">My Computer</h4>
                <p className="text-xs text-muted-foreground mb-3">
                  Download the desktop app to grant HackerAI access to your
                  computer.
                </p>
                <Button asChild size="sm" className="w-full">
                  <a
                    href={
                      detectedPlatform?.platform === "unknown"
                        ? "/download"
                        : detectedPlatform?.downloadUrl || "/download"
                    }
                  >
                    {detectedPlatform && detectedPlatform.platform !== "unknown"
                      ? `Download for ${detectedPlatform.displayName}`
                      : "Download desktop"}
                  </a>
                </Button>
              </PopoverContent>
            </Popover>
          )}

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
