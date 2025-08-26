import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { GlobalStateProvider } from "./contexts/GlobalState";
import { TodoBlockProvider } from "./contexts/TodoBlockContext";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  applicationName: "HackerAI",
  title: {
    default: "HackerAI - AI-Powered Penetration Testing Assistant",
    template: "%s",
  },
  description:
    "HackerAI provides advanced AI and integrated tools to help security teams conduct comprehensive penetration tests effortlessly. Scan, exploit, and analyze web applications, networks, and cloud environments with ease and precision, without needing expert skills.",
  keywords: [
    "hackerai",
    "hacker ai",
    "pentest ai",
    "penetration testing ai",
    "hacking ai",
    "pentesting ai",
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const content = (
    <GlobalStateProvider>
      <TodoBlockProvider>
        <TooltipProvider>
          {children}
          <Toaster />
        </TooltipProvider>
      </TodoBlockProvider>
    </GlobalStateProvider>
  );

  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <ConvexClientProvider>{content}</ConvexClientProvider>
      </body>
    </html>
  );
}
