import type { Metadata } from "next";
import { DownloadPageContent } from "./DownloadPageContent";

export const metadata: Metadata = {
  title: "Download | HackerAI",
  description:
    "Download HackerAI desktop app for macOS, Windows, and Linux. AI-powered penetration testing at your fingertips.",
  openGraph: {
    title: "Download HackerAI Desktop",
    description:
      "Download HackerAI desktop app for macOS, Windows, and Linux. AI-powered penetration testing at your fingertips.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Download HackerAI Desktop",
    description:
      "Download HackerAI desktop app for macOS, Windows, and Linux. AI-powered penetration testing at your fingertips.",
  },
};

export default function DownloadPage() {
  return <DownloadPageContent />;
}
