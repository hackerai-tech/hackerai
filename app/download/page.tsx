import type { Metadata } from "next";
import { DownloadPageContent } from "./DownloadPageContent";

export const metadata: Metadata = {
  title: "Download | ZHACKER",
  description:
    "Download ZHACKER for macOS, Windows, Linux, iOS, and Android. AI-powered penetration testing at your fingertips.",
  openGraph: {
    title: "Download ZHACKER",
    description:
      "Download ZHACKER for macOS, Windows, Linux, iOS, and Android. AI-powered penetration testing at your fingertips.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Download ZHACKER",
    description:
      "Download ZHACKER for macOS, Windows, Linux, iOS, and Android. AI-powered penetration testing at your fingertips.",
  },
};

export default function DownloadPage() {
  return <DownloadPageContent />;
}
