"use client";

import { Authenticated, Unauthenticated, AuthLoading } from "convex/react";
import { ChatLayout } from "@/app/components/ChatLayout";
import Loading from "@/components/ui/loading";
import { useVisualViewportHeight } from "@/app/hooks/useVisualViewportHeight";

const shellClass =
  "h-[var(--vvh,100dvh)] min-h-0 flex flex-col bg-background overflow-hidden";

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
  useVisualViewportHeight();

  return (
    <>
      <AuthLoading>
        <div className={shellClass}>
          <div className="flex-1 flex items-center justify-center min-h-0">
            <Loading />
          </div>
        </div>
      </AuthLoading>
      <Unauthenticated>
        <div className={shellClass}>{children}</div>
      </Unauthenticated>
      <Authenticated>
        <div className={shellClass}>
          <ChatLayout>{children}</ChatLayout>
        </div>
      </Authenticated>
    </>
  );
}
