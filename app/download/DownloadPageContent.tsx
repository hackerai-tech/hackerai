"use client";

import { Authenticated, Unauthenticated } from "convex/react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import Header from "@/app/components/Header";
import { HackerAISVG } from "@/components/icons/hackerai-svg";
import { DownloadSection } from "./DownloadSection";
import { downloadLinks } from "./constants";
import { AppleIcon, WindowsIcon, LinuxIcon } from "./icons";

function AuthenticatedHeader() {
  return (
    <header className="w-full px-6 max-sm:px-4 flex-shrink-0">
      <div className="py-[10px] flex gap-10 items-center justify-between">
        <div className="flex items-center gap-2">
          <HackerAISVG theme="dark" scale={0.15} />
          <span className="text-foreground text-xl font-semibold max-sm:text-lg">
            HackerAI
          </span>
        </div>
        <Button asChild variant="ghost" size="default" className="rounded-[10px]">
          <Link href="/">
            <ArrowLeft className="h-4 w-4 mr-1.5" />
            Back to Chat
          </Link>
        </Button>
      </div>
    </header>
  );
}

function DownloadContent() {
  return (
    <div className="px-4 py-8 pb-16 md:px-0">
      <div className="container mx-auto max-w-3xl space-y-8">
        <div className="text-center">
          <h1 className="mb-4 text-4xl font-bold text-card-foreground">
            Download HackerAI
          </h1>
          <p className="text-lg text-muted-foreground">
            Get the desktop app for the best experience
          </p>
        </div>

        <DownloadSection />

        <div className="rounded-md border bg-card p-6 shadow-lg">
          <h2 className="mb-4 text-xl font-semibold text-card-foreground">
            All Downloads
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
              subtitle="x64"
              href={downloadLinks.linuxAppImage}
              icon={<LinuxIcon />}
            />
            <DownloadCard
              title="Linux"
              subtitle="ARM64"
              href={downloadLinks.linuxArm64AppImage}
              icon={<LinuxIcon />}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export function DownloadPageContent() {
  return (
    <div className="min-h-screen bg-background">
      <Authenticated>
        <AuthenticatedHeader />
        <DownloadContent />
      </Authenticated>
      <Unauthenticated>
        <Header hideDownload />
        <DownloadContent />
      </Unauthenticated>
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
