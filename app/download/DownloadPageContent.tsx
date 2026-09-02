"use client";

import { ExternalLink } from "lucide-react";

import Header from "@/app/components/Header";
import { PublicSiteFooter } from "@/components/public/PublicSiteFooter";
import { LOCAL_AGENT_HELP_URL } from "@/lib/seo/site";
import { DownloadSection, useDetectedPlatform } from "./DownloadSection";
import { downloadLinks } from "./constants";
import { AppleIcon, WindowsIcon, LinuxIcon } from "./icons";

function DownloadContent() {
  const detected = useDetectedPlatform();
  const isMobile =
    detected?.platform === "ios" || detected?.platform === "android";

  return (
    <div className="mx-auto max-w-3xl px-4 py-14 sm:px-6 sm:py-20">
      <div className="space-y-8">
        <div className="text-center">
          <h1 className="text-5xl font-medium leading-[1.05] tracking-tight text-foreground sm:text-6xl">
            {isMobile ? "Install HackerAI" : "Download HackerAI"}
          </h1>
          <p className="mx-auto mt-4 max-w-2xl text-lg leading-8 text-muted-foreground">
            {isMobile
              ? "Add HackerAI to your home screen to open it like a native app."
              : "Install the desktop app when you want Agent mode to run tools on your own machine. Everything else works in the browser."}
          </p>
          {!isMobile && (
            <a
              href={LOCAL_AGENT_HELP_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-4 inline-flex items-center gap-2 rounded-sm text-sm font-medium text-foreground underline underline-offset-4 hover:text-foreground/80 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              Local Agent setup guide
              <ExternalLink className="size-4" aria-hidden="true" />
            </a>
          )}
        </div>

        <DownloadSection />

        {!isMobile && (
          <div className="rounded-lg border border-border bg-card p-6">
            <h2 className="text-xl font-semibold text-card-foreground">
              All desktop downloads
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Pick the build that matches your operating system and CPU
              architecture.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <DownloadCard
                title="macOS"
                subtitle="Universal (Intel & Apple Silicon)"
                href={downloadLinks.macos}
                icon={<AppleIcon />}
              />
              <DownloadCard
                title="Windows"
                subtitle="64-bit"
                href={downloadLinks.windows}
                icon={<WindowsIcon />}
              />
              <DownloadCard
                title="Linux"
                subtitle="x64 (.deb)"
                href={downloadLinks.linuxDeb}
                icon={<LinuxIcon />}
              />
              <DownloadCard
                title="Linux"
                subtitle="ARM64 (.deb)"
                href={downloadLinks.linuxArm64Deb}
                icon={<LinuxIcon />}
              />
              <DownloadCard
                title="Linux"
                subtitle="x64 (.AppImage)"
                href={downloadLinks.linuxAppImage}
                icon={<LinuxIcon />}
              />
              <DownloadCard
                title="Linux"
                subtitle="ARM64 (.AppImage)"
                href={downloadLinks.linuxArm64AppImage}
                icon={<LinuxIcon />}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function DownloadPageContent() {
  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <Header currentPath="/download" hideDownload />
      <main className="flex-1">
        <DownloadContent />
      </main>
      <PublicSiteFooter />
    </div>
  );
}

function DownloadCard({
  title,
  subtitle,
  href,
  icon,
}: {
  title: string;
  subtitle: string;
  href: string;
  icon: React.ReactNode;
}) {
  return (
    <a
      href={href}
      className="flex items-center gap-3 rounded-md border border-border bg-background p-4 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    >
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <div className="font-medium text-card-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{subtitle}</div>
      </div>
    </a>
  );
}
