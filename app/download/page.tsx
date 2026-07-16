import type { Metadata } from "next";
import { DownloadPageContent } from "./DownloadPageContent";

const DOWNLOAD_DESCRIPTION =
  "Download HackerAI for macOS, Windows, Linux, iOS, and Android. Run practical, authorized bug bounty and penetration-testing workflows anywhere.";

export const metadata: Metadata = {
  title: "Download | HackerAI",
  description: DOWNLOAD_DESCRIPTION,
  openGraph: {
    title: "Download HackerAI",
    description: DOWNLOAD_DESCRIPTION,
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Download HackerAI",
    description: DOWNLOAD_DESCRIPTION,
  },
};

export default function DownloadPage() {
  return <DownloadPageContent />;
}
