import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";

/**
 * Get the current user ID from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<string> - User ID
 * @throws ChatSDKError - When user is not authenticated
 */
export const getUserID = async (req: NextRequest): Promise<string> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    return session.user.id;
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    console.error("Failed to get user session:", error);
    throw new ChatSDKError("unauthorized:auth");
  }
};
