import { authkit } from "@workos-inc/authkit-nextjs";
import { NextRequest } from "next/server";

/**
 * Utility function to check if WorkOS authentication is properly configured
 * by verifying all required environment variables are present
 */
export const isWorkOSConfigured = (): boolean => {
  return !!(
    process.env.WORKOS_API_KEY &&
    process.env.WORKOS_CLIENT_ID &&
    process.env.WORKOS_COOKIE_PASSWORD &&
    process.env.NEXT_PUBLIC_WORKOS_REDIRECT_URI
  );
};

/**
 * Get the current user ID from the authenticated session
 * Falls back to "anonymous" if authentication is not configured or fails
 */
export const getUserID = async (req: NextRequest): Promise<string> => {
  if (!isWorkOSConfigured()) return "anonymous";

  try {
    const { session } = await authkit(req);
    return session?.user?.id || "anonymous";
  } catch (error) {
    console.error("Failed to get user session:", error);
    return "anonymous";
  }
};
