"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { downloadLinks } from "./constants";
import {
  AppleIcon,
  WindowsIcon,
  LinuxIcon,
  DeviceIcon,
  DownloadIcon,
} from "./icons";

type Platform = "macos" | "windows" | "linux" | "unknown";
type LinuxArch = "x64" | "arm64";

interface DetectedPlatform {
  platform: Platform;
  linuxArch?: LinuxArch;
  displayName: string;
  downloadUrl: string;
}

function detectPlatform(): DetectedPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() || "";

  if (
    userAgent.includes("mac") ||
    platform.includes("mac") ||
    userAgent.includes("darwin")
  ) {
    return {
      platform: "macos",
      displayName: "macOS",
      downloadUrl: downloadLinks.macos,
    };
  }

  if (userAgent.includes("win") || platform.includes("win")) {
    return {
      platform: "windows",
      displayName: "Windows",
      downloadUrl: downloadLinks.windows,
    };
  }

  if (
    userAgent.includes("linux") ||
    platform.includes("linux") ||
    userAgent.includes("x11")
  ) {
    const isArm =
      userAgent.includes("aarch64") ||
      userAgent.includes("arm64") ||
      platform.includes("aarch64") ||
      platform.includes("arm");

    if (isArm) {
      return {
        platform: "linux",
        linuxArch: "arm64",
        displayName: "Linux (ARM64)",
        downloadUrl: downloadLinks.linuxArm64AppImage,
      };
    }

    return {
      platform: "linux",
      linuxArch: "x64",
      displayName: "Linux",
      downloadUrl: downloadLinks.linuxAppImage,
    };
  }

  return {
    platform: "unknown",
    displayName: "your platform",
    downloadUrl: downloadLinks.macos,
  };
}

const serverSnapshot: DetectedPlatform | null = null;
let clientSnapshot: DetectedPlatform | null = null;

function getClientSnapshot(): DetectedPlatform {
  if (!clientSnapshot) {
    clientSnapshot = detectPlatform();
  }
  return clientSnapshot;
}

function getServerSnapshot(): DetectedPlatform | null {
  return serverSnapshot;
}

function subscribe() {
  return () => {};
}

function useDetectedPlatform(): DetectedPlatform | null {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

export function DownloadSection() {
  const detected = useDetectedPlatform();

  if (!detected) {
    return (
      <div className="rounded-md border bg-card p-8 text-center shadow-lg">
        <div className="h-20 animate-pulse rounded bg-muted" />
      </div>
    );
  }

  return (
    <div className="rounded-md border bg-card p-8 text-center shadow-lg">
      <div className="mb-6">
        <PlatformIcon platform={detected.platform} />
      </div>

      <Button asChild size="lg" className="mb-4 text-lg">
        <a href={detected.downloadUrl}>
          <DownloadIcon />
          Download for {detected.displayName}
        </a>
      </Button>

      {detected.platform === "unknown" && (
        <p className="mt-4 text-sm text-muted-foreground">
          Can&apos;t detect your OS? Choose from the options below.
        </p>
      )}
    </div>
  );
}

function PlatformIcon({ platform }: { platform: Platform }) {
  const className = "mx-auto h-16 w-16 text-muted-foreground";

  switch (platform) {
    case "macos":
      return <AppleIcon className={className} />;
    case "windows":
      return <WindowsIcon className={className} />;
    case "linux":
      return <LinuxIcon className={className} />;
    default:
      return <DeviceIcon className={className} />;
  }
}
