import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { GlobalStateProvider } from "./contexts/GlobalState";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { TodoBlockProvider } from "./contexts/TodoBlockContext";
import { PostHogProvider } from "./providers";
import { DataStreamProvider } from "./components/DataStreamProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const APP_NAME = "HackerAI";
const APP_DEFAULT_TITLE = "HackerAI - AI-Powered Penetration Testing Assistant";
const APP_TITLE_TEMPLATE = "%s | HackerAI";
const APP_DESCRIPTION =
  "HackerAI provides advanced AI and integrated tools to help security teams conduct comprehensive penetration tests effortlessly. Scan, exploit, and analyze web applications, networks, and cloud environments with ease and precision, without needing expert skills.";

export const metadata: Metadata = {
  applicationName: APP_NAME,
  title: {
    default: APP_DEFAULT_TITLE,
    template: "%s",
  },
  description: APP_DESCRIPTION,
  manifest: "/manifest.json",
  keywords: [
    "hackerai",
    "pentestgpt",
    "hacker ai",
    "pentest ai",
    "penetration testing ai",
    "hacking ai",
    "pentesting ai",
    "ai hacker",
    "hacker chat",
    "hacker chatbot",
    "hacker gpt",
    "hackerai chat",
    "hacking gpt",
    "pentest chat",
    "pentest gpt",
    "security ai",
  ],
  openGraph: {
    type: "website",
    siteName: APP_NAME,
    title: {
      default: APP_DEFAULT_TITLE,
      template: APP_TITLE_TEMPLATE,
    },
    description: APP_DESCRIPTION,
    images: [
      {
        url: "https://hackerai.co/icon-512x512.png",
        width: 512,
        height: 512,
        alt: "HackerAI",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: {
      default: APP_DEFAULT_TITLE,
      template: APP_TITLE_TEMPLATE,
    },
    description: APP_DESCRIPTION,
    images: [
      {
        url: "https://hackerai.co/icon-512x512.png",
        width: 512,
        height: 512,
        alt: "HackerAI",
      },
    ],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const content = (
    <GlobalStateProvider>
      <PostHogProvider>
        <DataStreamProvider>
          <TodoBlockProvider>
            <TooltipProvider>
              {children}
              <Toaster />
            </TooltipProvider>
          </TodoBlockProvider>
        </DataStreamProvider>
      </PostHogProvider>
    </GlobalStateProvider>
  );

  return (
    <html lang="en" className="dark h-full" suppressHydrationWarning>
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased h-full`}
      >
        <ConvexClientProvider>{content}</ConvexClientProvider>
      </body>
    </html>
  );
}
