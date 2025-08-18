/**
 * Server-only auth utilities
 * This file contains server-side authentication logic and should only be imported in server components/API routes
 */

import type { NextRequest } from "next/server";
import { isWorkOSEnabled } from "@/lib/auth/client";

/**
 * Get the current user ID from the authenticated session
 * Falls back to "anonymous" if authentication is not configured or fails
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<string> - User ID or "anonymous"
 */
export const getUserID = async (req: NextRequest): Promise<string> => {
  if (!isWorkOSEnabled()) return "anonymous";

  try {
    // Dynamic import to prevent client bundle inclusion
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);
    return session?.user?.id || "anonymous";
  } catch (error) {
    console.error("Failed to get user session:", error);
    return "anonymous";
  }
};
