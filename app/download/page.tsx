import type { Metadata } from "next";
import { DownloadPageContent } from "./DownloadPageContent";

const DOWNLOAD_DESCRIPTION =
  "Download the HackerAI desktop and mobile app. Connect your AI hacking assistant to local tools, files, codebases, and authorized test environments.";

export const metadata: Metadata = {
  title: "Download HackerAI — Desktop AI Hacking Assistant",
  description: DOWNLOAD_DESCRIPTION,
  openGraph: {
    title: "Download HackerAI — Desktop AI Hacking Assistant",
    description: DOWNLOAD_DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Download HackerAI — Desktop AI Hacking Assistant",
    description: DOWNLOAD_DESCRIPTION,
  },
};

export default function DownloadPage() {
  return <DownloadPageContent />;
}
