"use client";

import { ChevronDown, ExternalLink } from "lucide-react";
import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { GITHUB_URL, LOCAL_AGENT_HELP_URL } from "@/lib/seo/site";
import { MobileInstallPanel, useDetectedPlatform } from "./DownloadSection";
import { downloadLinks } from "./constants";
import { AppleIcon, DownloadIcon, LinuxIcon, WindowsIcon } from "./icons";

const builds = [
  {
    name: "macOS",
    detail: "Universal · Intel and Apple Silicon",
    platform: "macos",
    icon: AppleIcon,
    files: [{ label: ".dmg", href: downloadLinks.macos }],
  },
  {
    name: "Windows",
    detail: "x64",
    platform: "windows",
    icon: WindowsIcon,
    files: [{ label: ".exe", href: downloadLinks.windows }],
  },
  {
    name: "Linux",
    detail: "x64",
    platform: "linux-x64",
    icon: LinuxIcon,
    files: [
      { label: ".deb", href: downloadLinks.linuxDeb },
      { label: ".AppImage", href: downloadLinks.linuxAppImage },
    ],
  },
  {
    name: "Linux",
    detail: "ARM64",
    platform: "linux-arm64",
    icon: LinuxIcon,
    files: [
      { label: ".deb", href: downloadLinks.linuxArm64Deb },
      { label: ".AppImage", href: downloadLinks.linuxArm64AppImage },
    ],
  },
] as const;

function LocalAgentGuide() {
  return (
    <a
      href={LOCAL_AGENT_HELP_URL}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      Local Agent setup guide{" "}
      <ExternalLink className="size-3.5" aria-hidden="true" />
    </a>
  );
}

function PrimaryDownload() {
  const detected = useDetectedPlatform();
  const unknown = detected?.platform === "unknown";
  const caption =
    detected?.platform === "macos"
      ? "Universal build for Intel and Apple Silicon · .dmg"
      : detected?.platform === "windows"
        ? "x64 installer · .exe"
        : detected?.platform === "linux"
          ? `${detected.linuxArch === "arm64" ? "ARM64" : "x64"} · .deb for Debian or Ubuntu`
          : unknown
            ? "Choose the build for your operating system below."
            : "";

  return (
    <div className="mt-10">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
        {!detected ? (
          <div className="h-12 w-56 animate-pulse rounded-[10px] bg-muted" />
        ) : unknown ? (
          <a
            href="#all-downloads"
            className="inline-flex h-12 items-center justify-center rounded-[10px] bg-foreground px-6 font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Choose your download
          </a>
        ) : (
          <a
            href={detected.downloadUrl}
            className="inline-flex h-12 items-center justify-center gap-2 rounded-[10px] bg-foreground px-6 font-medium text-background hover:bg-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <DownloadIcon className="size-5" aria-hidden="true" /> Download for{" "}
            {detected.displayName}
          </a>
        )}
        <LocalAgentGuide />
      </div>
      <p className="mt-4 min-h-5 text-sm text-muted-foreground">{caption}</p>
    </div>
  );
}

function DownloadRows({
  detected,
}: {
  detected: ReturnType<typeof useDetectedPlatform>;
}) {
  return (
    <>
      <ul className="divide-y divide-border border-b border-border">
        {builds.map((build) => {
          const Icon = build.icon;
          const yourSystem =
            detected?.platform === build.platform ||
            (detected?.platform === "linux" &&
              build.platform === `linux-${detected.linuxArch}`);
          return (
            <li
              key={build.platform}
              className="flex min-h-[76px] items-center gap-4 py-3.5 sm:gap-5"
            >
              <Icon
                className="size-5 shrink-0 text-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-baseline gap-x-2 text-sm font-medium text-foreground">
                  {build.name}
                  {yourSystem ? (
                    <span className="font-mono text-[10px] font-normal uppercase tracking-[0.14em] text-[#b9b7ff]">
                      Your system
                    </span>
                  ) : null}
                </p>
                <p className="text-xs text-muted-foreground">{build.detail}</p>
              </div>
              <div className="flex shrink-0 flex-wrap justify-end gap-2">
                {build.files.map((file) => (
                  <a
                    key={file.href}
                    href={file.href}
                    aria-label={`Download ${build.name} ${build.detail} ${file.label}`}
                    className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg border border-border px-2.5 text-xs text-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-3 sm:text-sm"
                  >
                    <DownloadIcon className="size-3.5" aria-hidden="true" />
                    {file.label}
                  </a>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
      <p className="mt-5 text-xs leading-5 text-muted-foreground">
        Use .deb on Debian or Ubuntu. AppImage runs on most other distributions.
      </p>
    </>
  );
}

function AllDownloads({ mobileDevice }: { mobileDevice: boolean }) {
  const detected = useDetectedPlatform();
  if (mobileDevice) {
    return (
      <section
        id="all-downloads"
        className="mt-10 border-t border-border lg:mt-0"
      >
        <details open className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 py-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
            <span>
              <span className="block text-base font-semibold">
                Desktop downloads
              </span>
              <span className="block text-xs text-muted-foreground">
                Local Agent for macOS, Windows, and Linux
              </span>
            </span>
            <ChevronDown
              className="size-4 shrink-0 transition-transform group-open:rotate-180"
              aria-hidden="true"
            />
          </summary>
          <DownloadRows detected={detected} />
          <div className="mt-5">
            <LocalAgentGuide />
          </div>
        </details>
      </section>
    );
  }
  return (
    <section id="all-downloads" aria-labelledby="all-downloads-title">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2 border-b border-border pb-4">
        <h2 id="all-downloads-title" className="text-lg font-semibold">
          All downloads
        </h2>
        <a
          href={`${GITHUB_URL}/releases/latest`}
          target="_blank"
          rel="noreferrer"
          className="text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Latest release on GitHub
        </a>
      </div>
      <DownloadRows detected={detected} />
    </section>
  );
}

function DownloadContent() {
  const detected = useDetectedPlatform();
  const mobileDevice =
    detected?.platform === "ios" || detected?.platform === "android";
  return (
    <div className="mx-auto grid max-w-[1280px] gap-12 px-4 pb-20 pt-10 sm:px-6 sm:pt-16 lg:grid-cols-[minmax(0,1fr)_minmax(0,500px)] lg:items-start lg:gap-16 lg:px-10 lg:pb-28 lg:pt-24">
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase tracking-[0.16em] text-muted-foreground">
          Download
        </p>
        <h1 className="mt-4 text-[clamp(2.7rem,5vw,4.7rem)] font-semibold leading-[1.05] tracking-[-0.055em] sm:mt-6">
          {mobileDevice ? "Install HackerAI" : "Download HackerAI"}
        </h1>
        <p className="mt-5 max-w-[530px] text-base leading-7 text-muted-foreground sm:text-lg">
          {mobileDevice
            ? "Add HackerAI to your home screen to open it like an app."
            : "Install the desktop app when you want Agent mode to run tools on your own machine. Everything else works in the browser."}
        </p>
        {mobileDevice && detected ? (
          <MobileInstallPanel detected={detected} />
        ) : (
          <PrimaryDownload />
        )}
      </div>
      <AllDownloads mobileDevice={mobileDevice} />
    </div>
  );
}

export function DownloadPageContent() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <Header currentPath="/download" publicRedesign />
      <main className="flex-1">
        <DownloadContent />
      </main>
      <PublicSiteFooter redesign />
    </div>
  );
}
