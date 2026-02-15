"use client";

import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { ChatLayout } from "@/app/components/ChatLayout";
import Loading from "@/components/ui/loading";

/**
 * Shared layout for the (chat) route group. Renders the chat sidebar only when
 * authenticated so it stays mounted when navigating between / and /c/[id].
 * AuthLoading and Unauthenticated get a full-width shell (no sidebar).
 */
export default function ChatGroupLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Authenticated>
        <ChatLayout>{children}</ChatLayout>
      </Authenticated>
      <AuthLoading>
        <div className="h-full bg-background flex flex-col overflow-hidden">
          <div className="flex-1 flex items-center justify-center">
            <Loading />
          </div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div className="h-full bg-background flex flex-col overflow-hidden">
          {children}
        </div>
      </Unauthenticated>
    </>
  );
}
