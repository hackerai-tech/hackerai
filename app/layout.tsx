import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import { withAuth } from "@workos-inc/authkit-nextjs";
import "./globals.css";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { GlobalStateProvider } from "./contexts/GlobalState";
import { ConvexClientProvider } from "@/components/ConvexClientProvider";
import { TodoBlockProvider } from "./contexts/TodoBlockContext";
import { AgentApprovalProvider } from "./contexts/AgentApprovalContext";
import { PostHogProvider } from "./providers";
import { DataStreamProvider } from "./components/DataStreamProvider";
import { ChunkLoadRecovery } from "./components/ChunkLoadRecovery";
import { PUBLIC_METADATA } from "@/lib/marketing/positioning";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const APP_NAME = "HackerAI";
const APP_DEFAULT_TITLE = PUBLIC_METADATA.title;
const APP_TITLE_TEMPLATE = "%s | HackerAI";
const APP_DESCRIPTION = PUBLIC_METADATA.description;

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
    "technical ai assistant",
    "ai for technical work",
    "ai coding assistant",
    "ai research assistant",
    "ai automation assistant",
    "developer ai assistant",
    "pentest ai",
    "penetration testing tool",
    "penetration testing ai",
    "pentesting ai",
    "pentest automation",
    "authorized security testing ai",
    "security assessment ai",
    "application security ai",
    "security code review ai",
    "exploit validation ai",
    "pentest reporting ai",
    "offensive security ai",
    "cybersecurity ai assistant",
    "bug bounty ai",
    "bug bounty assistant",
    "security lab assistant",
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

async function getInitialAuth() {
  const requestHeaders = await headers();

  // Static public pages are prerendered without proxy-injected AuthKit headers.
  if (!requestHeaders.has("x-workos-middleware")) {
    return { user: null } as const;
  }

  // Never serialize the server-only access token into the client provider.
  const { accessToken, ...initialAuth } = await withAuth();
  return initialAuth;
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // Supplying server-resolved auth prevents AuthKitProvider from invoking its
  // getAuth Server Action on every mount.
  const initialAuth = await getInitialAuth();

  const content = (
    <GlobalStateProvider>
      <PostHogProvider>
        <ChunkLoadRecovery />
        <DataStreamProvider>
          <TodoBlockProvider>
            <AgentApprovalProvider>
              <TooltipProvider>
                {children}
                <Toaster />
              </TooltipProvider>
            </AgentApprovalProvider>
          </TodoBlockProvider>
        </DataStreamProvider>
      </PostHogProvider>
    </GlobalStateProvider>
  );

  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} dark h-full`}
      suppressHydrationWarning
    >
      <head>
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
      </head>
      <body className="antialiased h-full">
        <ConvexClientProvider initialAuth={initialAuth}>
          {content}
        </ConvexClientProvider>
      </body>
    </html>
  );
}
