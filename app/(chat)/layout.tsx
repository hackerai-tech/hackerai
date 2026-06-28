"use client";

import { useConvexAuth } from "convex/react";
import { ChatLayout } from "@/app/components/ChatLayout";
import Loading from "@/components/ui/loading";
import { hasAuthenticatedBefore } from "@/lib/utils/client-storage";

const fullWidthShell = (
  <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
    <div className="flex-1 flex items-center justify-center min-h-0">
      <Loading />
    </div>
  </div>
);

/**
 * Shared layout for / and /c/[id]. Renders the Chat Sidebar only when authenticated
 * so it stays mounted across navigations within the group. Returning users keep
 * the shell mounted during brief auth refreshes so active streams and
 * computer-sidebar state do not flash away.
 */
export default function ChatRouteLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();

  if (isAuthenticated || (isLoading && hasAuthenticatedBefore())) {
    return (
      <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
        <ChatLayout>{children}</ChatLayout>
      </div>
    );
  }

  if (isLoading) {
    return fullWidthShell;
  }

  return (
    <div className="h-dvh min-h-0 flex flex-col bg-background overflow-hidden">
      {children}
    </div>
  );
}
