"use client";

import { PublicSiteHeader } from "@/components/public/PublicSiteHeader";
import { DownloadSection, useDetectedPlatform } from "./DownloadSection";
import { downloadLinks } from "./constants";
import { AppleIcon, WindowsIcon, LinuxIcon } from "./icons";

function DownloadContent() {
  const detected = useDetectedPlatform();
  const isMobile =
    detected?.platform === "ios" || detected?.platform === "android";

  return (
    <div className="px-4 py-8 pb-16 md:px-0">
      <div className="container mx-auto max-w-3xl space-y-8">
        <div className="text-center">
          <h1 className="mb-4 text-4xl font-bold text-card-foreground">
            {isMobile ? "Install HackerAI" : "Download HackerAI"}
          </h1>
          <p className="text-lg text-muted-foreground">
            {isMobile
              ? "Add the app to your home screen"
              : "Get the desktop app for the best experience"}
          </p>
        </div>

        <DownloadSection />

        {!isMobile && (
          <div className="rounded-md border bg-card p-6 shadow-lg">
            <h2 className="mb-4 text-xl font-semibold text-card-foreground">
              Desktop Downloads
            </h2>
            <div className="grid gap-4 sm:grid-cols-2">
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
    <div className="min-h-screen bg-background">
      <PublicSiteHeader />
      <main>
        <DownloadContent />
      </main>
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
      className="flex items-center gap-3 rounded-md border bg-background p-4 transition-colors hover:bg-accent"
    >
      <div className="text-muted-foreground">{icon}</div>
      <div>
        <div className="font-medium text-card-foreground">{title}</div>
        <div className="text-sm text-muted-foreground">{subtitle}</div>
      </div>
    </a>
  );
}
