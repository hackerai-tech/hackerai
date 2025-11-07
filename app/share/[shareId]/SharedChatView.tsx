"use client";

import { useQuery } from "convex/react";
import { api } from "@/convex/_generated/api";
import { SharedMessages } from "./SharedMessages";
import { Loader2, AlertCircle } from "lucide-react";
import Link from "next/link";

interface SharedChatViewProps {
  shareId: string;
}

// UUID format validation regex (matches v4 and other UUID versions)
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function SharedChatView({ shareId }: SharedChatViewProps) {
  // Validate shareId format before making database query
  const isValidUUID = UUID_REGEX.test(shareId);

  const chat = useQuery(
    api.chats.getSharedChat,
    isValidUUID ? { shareId } : "skip"
  );
  const messages = useQuery(
    api.messages.getSharedMessages,
    chat ? { chatId: chat.id } : "skip"
  );

  // Invalid UUID format - show not found immediately
  if (!isValidUUID) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4 max-w-md text-center p-6">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Invalid share link</h1>
          <p className="text-sm text-muted-foreground">
            This share link appears to be malformed. Please check the URL and
            try again.
          </p>
        </div>
      </div>
    );
  }

  // Loading state
  if (chat === undefined) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">Loading shared chat...</p>
        </div>
      </div>
    );
  }

  // Chat not found or not shared
  if (chat === null) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="flex flex-col items-center gap-4 max-w-md text-center p-6">
          <AlertCircle className="h-12 w-12 text-muted-foreground" />
          <h1 className="text-2xl font-semibold">Chat not found</h1>
          <p className="text-sm text-muted-foreground">
            This shared chat doesn&apos;t exist or is no longer available. It may
            have been unshared by the owner.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b sticky top-0 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 z-10">
        <div className="container max-w-4xl mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-lg font-semibold truncate">{chat.title}</h1>
              <p className="text-xs text-muted-foreground mt-1">
                Shared conversation • Read-only
              </p>
            </div>
            <Link
              href="/"
              className="text-sm text-primary hover:underline"
            >
              Try HackerAI
            </Link>
          </div>
        </div>
      </header>

      {/* Messages */}
      <main className="container max-w-4xl mx-auto px-4 py-6">
        {messages === undefined ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <SharedMessages messages={messages} shareDate={chat.share_date} />
        )}
      </main>

      {/* Footer */}
      <footer className="border-t mt-12">
        <div className="container max-w-4xl mx-auto px-4 py-6 text-center text-sm text-muted-foreground">
          <p>
            This is a shared conversation. Files and images are not included for
            privacy.
          </p>
          <p className="mt-2">
            Powered by{" "}
            <Link href="/" className="text-primary hover:underline">
              HackerAI
            </Link>
          </p>
        </div>
      </footer>
    </div>
  );
}
