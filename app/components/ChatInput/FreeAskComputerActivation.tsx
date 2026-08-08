"use client";

import { useEffect, useRef, useState } from "react";
import { Cloud, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useDetectedPlatform } from "@/app/download/DownloadSection";
import { redirectToPricing } from "@/app/hooks/usePricingDialog";
import { useTauri } from "@/app/hooks/useTauri";
import {
  captureAuthenticatedEvent,
  captureUpgradeCtaImpression,
} from "@/lib/analytics/client";

const ANALYTICS_SURFACE = "chat_input_computer_activation";
const ANALYTICS_SOURCE = "free_ask_computer_activation";

export function FreeAskComputerActivation() {
  const [open, setOpen] = useState(false);
  const capturedImpressionRef = useRef(false);
  const capturedUpgradeImpressionRef = useRef(false);
  const detectedPlatform = useDetectedPlatform();
  const { isTauri } = useTauri();

  useEffect(() => {
    if (isTauri || capturedImpressionRef.current) return;

    capturedImpressionRef.current = true;
    captureAuthenticatedEvent("computer_activation_cta_impressed", {
      surface: ANALYTICS_SURFACE,
      source: ANALYTICS_SOURCE,
      subscription_tier: "free",
      chat_mode: "ask",
    });
  }, [isTauri]);

  useEffect(() => {
    if (!open || capturedUpgradeImpressionRef.current) return;

    capturedUpgradeImpressionRef.current = true;
    captureUpgradeCtaImpression({
      surface: ANALYTICS_SURFACE,
      source: ANALYTICS_SOURCE,
      from_tier: "free",
      cta_text: "Upgrade for Cloud Agent",
    });
  }, [open]);

  if (isTauri) return null;

  const isMobilePlatform =
    detectedPlatform?.platform === "ios" ||
    detectedPlatform?.platform === "android";
  const downloadHref = detectedPlatform?.downloadUrl || "/download";

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen) return;

    captureAuthenticatedEvent("computer_activation_cta_clicked", {
      surface: ANALYTICS_SURFACE,
      source: ANALYTICS_SOURCE,
      subscription_tier: "free",
      chat_mode: "ask",
    });
  };

  const handleDesktopDownload = () => {
    captureAuthenticatedEvent("computer_activation_download_clicked", {
      surface: ANALYTICS_SURFACE,
      source: ANALYTICS_SOURCE,
      subscription_tier: "free",
      chat_mode: "ask",
      platform: detectedPlatform?.platform ?? "unknown",
    });
    setOpen(false);
  };

  const handleCloudUpgrade = () => {
    setOpen(false);
    redirectToPricing({
      surface: ANALYTICS_SURFACE,
      source: ANALYTICS_SOURCE,
      from_tier: "free",
      cta_text: "Upgrade for Cloud Agent",
    });
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 w-7 rounded-md bg-muted p-0 text-foreground shadow-none hover:bg-muted/50 md:w-auto md:px-2"
          aria-label="Set up HackerAI Desktop for Agent mode"
          title="Set up HackerAI Desktop"
          data-testid="free-ask-computer-activation-trigger"
        >
          <Monitor className="size-4" aria-hidden="true" />
          <span className="hidden md:inline" translate="no">
            HackerAI Desktop
          </span>
        </Button>
      </PopoverTrigger>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-[300px] max-w-[calc(100vw-24px)] overflow-hidden p-0"
        data-testid="free-ask-computer-activation-popover"
      >
        <div className="space-y-3 p-3">
          <div className="flex items-start gap-2">
            <Monitor
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">Use Your Computer</p>
              <p className="text-xs text-muted-foreground">
                Let Agent work with files and terminal tools on your computer.
              </p>
            </div>
          </div>

          {isMobilePlatform ? (
            <p className="text-xs text-muted-foreground">
              Use a desktop computer to download{" "}
              <span translate="no">HackerAI Desktop</span> for macOS, Windows,
              or Linux.
            </p>
          ) : (
            <Button asChild size="sm" className="w-full">
              <a
                href={downloadHref}
                target="_blank"
                rel="noopener noreferrer"
                onClick={handleDesktopDownload}
                data-testid="free-ask-computer-download"
              >
                Download <span translate="no">HackerAI Desktop</span>
              </a>
            </Button>
          )}
        </div>

        <div className="border-t p-3">
          <div className="mb-3 flex items-start gap-2">
            <Cloud
              className="mt-0.5 size-5 shrink-0 text-muted-foreground"
              aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
              <p className="text-sm font-medium">Cloud Computer</p>
              <p className="text-xs text-muted-foreground">
                An always-available workspace for Agent, with no local setup.
              </p>
            </div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleCloudUpgrade}
            data-testid="free-ask-cloud-upgrade"
          >
            Upgrade for Cloud Agent
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
