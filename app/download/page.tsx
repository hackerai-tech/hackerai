import type { Metadata } from "next";
import { DownloadPageContent } from "./DownloadPageContent";

export const metadata: Metadata = {
  title: "Download | HackerAI",
  description:
    "Download HackerAI for macOS, Windows, Linux, iOS, and Android. Run practical, authorized bug bounty and penetration-testing workflows anywhere.",
  openGraph: {
    title: "Download HackerAI",
    description:
      "Download HackerAI for macOS, Windows, Linux, iOS, and Android. Run practical, authorized bug bounty and penetration-testing workflows anywhere.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Download HackerAI",
    description:
      "Download HackerAI for macOS, Windows, Linux, iOS, and Android. Run practical, authorized bug bounty and penetration-testing workflows anywhere.",
  },
};

export default function DownloadPage() {
  return <DownloadPageContent />;
}
