"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { downloadLinks } from "./constants";
import {
  AppleIcon,
  WindowsIcon,
  LinuxIcon,
  AndroidIcon,
  DeviceIcon,
  DownloadIcon,
} from "./icons";

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
type LinuxArch = "x64" | "arm64";
type Browser = "safari" | "chrome" | "firefox" | "samsung" | "other";

export interface DetectedPlatform {
  platform: Platform;
  linuxArch?: LinuxArch;
  browser?: Browser;
  displayName: string;
  downloadUrl: string;
}

function detectBrowser(ua: string): Browser {
  if (/samsungbrowser/.test(ua)) return "samsung";
  if (/firefox|fxios/.test(ua)) return "firefox";
  if (/safari/.test(ua) && !/crios|fxios|edgios|chrome|android/.test(ua)) {
    return "safari";
  }
  if (/chrome|crios/.test(ua) && !/edg|opr/.test(ua)) return "chrome";
  return "other";
}

export function detectPlatform(): DetectedPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() || "";
  const browser = detectBrowser(userAgent);

  const isIpadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  if (/iphone|ipad|ipod/.test(userAgent) || isIpadOS) {
    return {
      platform: "ios",
      browser,
      displayName: "iOS",
      downloadUrl: "",
    };
  }

  if (/android/.test(userAgent)) {
    return {
      platform: "android",
      browser,
      displayName: "Android",
      downloadUrl: "",
    };
  }

  if (
    userAgent.includes("mac") ||
    platform.includes("mac") ||
    userAgent.includes("darwin")
  ) {
    return {
      platform: "macos",
      browser,
      displayName: "macOS",
      downloadUrl: downloadLinks.macos,
    };
  }

  if (userAgent.includes("win") || platform.includes("win")) {
    return {
      platform: "windows",
      browser,
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
        browser,
        displayName: "Linux (ARM64)",
        downloadUrl: downloadLinks.linuxArm64Deb,
      };
    }

    return {
      platform: "linux",
      linuxArch: "x64",
      browser,
      displayName: "Linux",
      downloadUrl: downloadLinks.linuxDeb,
    };
  }

  return {
    platform: "unknown",
    browser,
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

export function useDetectedPlatform(): DetectedPlatform | null {
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

  if (detected.platform === "ios" || detected.platform === "android") {
    return <MobileInstallCard detected={detected} />;
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

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

function MobileInstallCard({ detected }: { detected: DetectedPlatform }) {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    if (detected.platform !== "android") return;

    const handleBeforeInstall = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      setInstalled(true);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, [detected.platform]);

  const handleInstallClick = async () => {
    if (!deferredPrompt) return;
    try {
      await deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === "accepted") {
        setInstalled(true);
      }
    } catch {
      // Prompt already shown or blocked by the browser — fall back to manual steps.
    } finally {
      setDeferredPrompt(null);
    }
  };

  return (
    <div className="rounded-md border bg-card p-8 shadow-lg">
      <div className="mb-6 text-center">
        <MobilePlatformIcon platform={detected.platform} />
        <h2 className="mt-4 text-2xl font-semibold text-card-foreground">
          Install Mobile App
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Install HackerAI on your {detected.displayName} device
        </p>
      </div>

      {installed && (
        <div className="mb-4 rounded-md border border-green-500/30 bg-green-500/10 p-4 text-center text-sm text-green-600 dark:text-green-400">
          Installed! Open HackerAI from your home screen.
        </div>
      )}

      {!installed && deferredPrompt && (
        <>
          <Button
            size="lg"
            className="mb-4 w-full text-lg"
            onClick={handleInstallClick}
          >
            <DownloadIcon />
            Install HackerAI
          </Button>
          <div className="mb-4 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>Or install manually</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      {!installed && <InstallInstructions detected={detected} />}
    </div>
  );
}

function InstallInstructions({ detected }: { detected: DetectedPlatform }) {
  if (detected.platform === "ios") {
    if (detected.browser !== "safari") {
      return (
        <div className="rounded-md border bg-background p-4 text-sm text-muted-foreground">
          <p className="mb-2 font-medium text-card-foreground">
            Installing on iOS requires Safari
          </p>
          <p>Open this page in Safari to add HackerAI to your home screen.</p>
        </div>
      );
    }

    return (
      <StepsList
        steps={[
          <>
            Tap the <strong>Share</strong> button at the bottom of Safari (the
            square with an arrow pointing up).
          </>,
          <>
            Scroll down and tap <strong>Add to Home Screen</strong>.
          </>,
          <>
            Tap <strong>Add</strong> in the top right corner.
          </>,
        ]}
      />
    );
  }

  // Android
  if (detected.browser === "firefox") {
    return (
      <StepsList
        steps={[
          <>
            Tap the <strong>menu</strong> (⋮).
          </>,
          <>
            Tap <strong>Install</strong> (or <strong>Add to Home Screen</strong>
            ).
          </>,
        ]}
      />
    );
  }

  return (
    <StepsList
      steps={[
        <>
          Tap the <strong>menu</strong> button (three dots in the top right)
        </>,
        <>
          Tap <strong>Install app</strong> or{" "}
          <strong>Add to Home screen</strong>
        </>,
        <>
          Tap <strong>Install</strong> to confirm
        </>,
      ]}
    />
  );
}

function StepsList({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step, i) => (
        <li key={i} className="flex gap-3 text-sm text-card-foreground">
          <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
            {i + 1}
          </span>
          <span className="pt-0.5">{step}</span>
        </li>
      ))}
    </ol>
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

function MobilePlatformIcon({ platform }: { platform: Platform }) {
  const className = "mx-auto h-16 w-16 text-muted-foreground";

  switch (platform) {
    case "ios":
      return <AppleIcon className={className} />;
    case "android":
      return <AndroidIcon className={className} />;
    default:
      return <DeviceIcon className={className} />;
  }
}
