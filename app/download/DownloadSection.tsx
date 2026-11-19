"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useIsStandalone } from "@/hooks/use-is-standalone";
import { downloadLinks } from "./constants";
import { DownloadIcon } from "./icons";

type Platform = "macos" | "windows" | "linux" | "ios" | "android" | "unknown";
type LinuxArch = "x64" | "arm64";

export interface DetectedPlatform {
  platform: Platform;
  linuxArch?: LinuxArch;
  displayName: string;
  downloadUrl: string;
}

export function detectPlatform(): DetectedPlatform {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() || "";

  const isIpadOS =
    navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;

  if (/iphone|ipad|ipod/.test(userAgent) || isIpadOS) {
    return {
      platform: "ios",
      displayName: "iOS",
      downloadUrl: "",
    };
  }

  if (/android/.test(userAgent)) {
    return {
      platform: "android",
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
        downloadUrl: downloadLinks.linuxArm64Deb,
      };
    }

    return {
      platform: "linux",
      linuxArch: "x64",
      displayName: "Linux",
      downloadUrl: downloadLinks.linuxDeb,
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

export function useDetectedPlatform(): DetectedPlatform | null {
  return useSyncExternalStore(subscribe, getClientSnapshot, getServerSnapshot);
}

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function MobileInstallPanel({
  detected,
}: {
  detected: DetectedPlatform;
}) {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const isStandalone = useIsStandalone();

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

  if (isStandalone) {
    return (
      <div className="mt-9 border-t border-border pt-5">
        <h2 className="text-lg font-semibold">HackerAI is installed</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          You&apos;re already running HackerAI as an installed app.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-9">
      <div className="flex items-baseline justify-between gap-3 border-b border-border pb-4">
        <h2 className="text-lg font-semibold">
          {detected.platform === "ios" ? "On iPhone or iPad" : "On Android"}
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-[#b9b7ff]">
          Your device
        </span>
      </div>

      {installed && (
        <p
          role="status"
          className="mt-5 rounded-lg border border-border bg-card px-4 py-3 text-sm"
        >
          Installed. Open HackerAI from your home screen.
        </p>
      )}

      {!installed && deferredPrompt && (
        <>
          <button
            type="button"
            className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[10px] bg-foreground px-5 font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={handleInstallClick}
          >
            <DownloadIcon className="size-5" aria-hidden="true" />
            Install HackerAI
          </button>
          <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
            <div className="h-px flex-1 bg-border" />
            <span>Or install manually</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        </>
      )}

      {!installed && <InstallInstructions platform={detected.platform} />}
      {!installed && (
        <p className="mt-5 text-sm leading-6 text-muted-foreground">
          {detected.platform === "ios" ? (
            <>
              <span className="font-medium text-foreground">On Android?</span>{" "}
              Open the browser menu (⋮) and tap Install app or Add to Home
              screen.
            </>
          ) : (
            <>
              <span className="font-medium text-foreground">
                On iPhone or iPad?
              </span>{" "}
              Use Safari&apos;s Share menu, then Add to Home Screen.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function InstallInstructions({ platform }: { platform: Platform }) {
  if (platform === "ios") {
    return (
      <StepsList
        steps={[
          <>
            Tap <strong>Share</strong>, the square with an arrow. You may need
            to tap the ⋯ menu first.
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

  return (
    <StepsList
      steps={[
        <>
          Tap the <strong>menu</strong> button (three dots in the top right).
        </>,
        <>
          Tap <strong>Install app</strong> or{" "}
          <strong>Add to Home screen</strong>
        </>,
        <>
          Tap <strong>Install</strong> to confirm.
        </>,
      ]}
    />
  );
}

function StepsList({ steps }: { steps: React.ReactNode[] }) {
  return (
    <ol className="divide-y divide-border border-b border-border">
      {steps.map((step, i) => (
        <li
          key={i}
          className="flex gap-4 py-3.5 text-sm leading-6 text-muted-foreground"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
            {i + 1}
          </span>
          <span className="pt-0.5 [&_strong]:font-medium [&_strong]:text-foreground">
            {step}
          </span>
        </li>
      ))}
    </ol>
  );
}
