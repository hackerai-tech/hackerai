"use client";

import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { ChatLayout } from "@/app/components/ChatLayout";
import Loading from "@/components/ui/loading";

const fullWidthShell = (
  <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
    <div className="flex-1 flex items-center justify-center min-h-0">
      <Loading />
    </div>
  </div>
);

/**
 * Shared layout for / and /c/[id]. Renders the Chat Sidebar only when authenticated
 * so it stays mounted across navigations within the group. AuthLoading and
 * Unauthenticated get a full-width shell (no sidebar).
 */
export default function ChatRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <AuthLoading>{fullWidthShell}</AuthLoading>
      <Unauthenticated>
        <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
          {children}
        </div>
      </Unauthenticated>
      <Authenticated>
        <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
          <ChatLayout>{children}</ChatLayout>
        </div>
      </Authenticated>
    </>
  );
}
