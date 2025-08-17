import { authkit } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";

/**
 * Auth modes supported by the application
 */
export type AuthMode = "workos" | "anonymous";

/**
 * Check if WorkOS authentication is enabled
 * Works on both server and client side
 */
export const isWorkOSEnabled = () =>
  process.env.NEXT_PUBLIC_AUTH_MODE === "workos";

/**
 * Get the current user ID from the authenticated session
 * Falls back to "anonymous" if authentication is not configured or fails
 */
export const getUserID = async (req: NextRequest): Promise<string> => {
  if (!isWorkOSEnabled()) return "anonymous";

  try {
    const { session } = await authkit(req);
    return session?.user?.id || "anonymous";
  } catch (error) {
    console.error("Failed to get user session:", error);
    return "anonymous";
  }
};
