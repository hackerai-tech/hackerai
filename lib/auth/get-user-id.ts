import type { NextRequest } from "next/server";
import { ChatSDKError } from "@/lib/errors";
// import { WorkOS } from "@workos-inc/node";

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

/**
 * Get the current user ID and pro status from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<{userId: string, isPro: boolean}> - Object with userId and isPro
 * @throws ChatSDKError - When user is not authenticated
 */
// export const getUserIDAndPro = async (
//   req: NextRequest,
// ): Promise<{ userId: string; isPro: boolean }> => {
//   try {
//     const workos = new WorkOS(process.env.WORKOS_API_KEY!, {
//       clientId: process.env.WORKOS_CLIENT_ID!,
//     });

//     // Get the session cookie
//     const sessionCookie = req.cookies.get("wos-session")?.value;

//     if (!sessionCookie) {
//       throw new ChatSDKError("unauthorized:auth");
//     }

//     // Load and refresh the session to get latest entitlements
//     const session = workos.userManagement.loadSealedSession({
//       cookiePassword: process.env.WORKOS_COOKIE_PASSWORD!,
//       sessionData: sessionCookie,
//     });

//     const refreshResult = await session.refresh();
//     const { entitlements, user } = refreshResult as any;

//     if (!user?.id) {
//       throw new ChatSDKError("unauthorized:auth");
//     }

//     // Check if user has pro entitlements (fresh data)
//     const isPro = (entitlements || []).includes("pro-monthly-plan");

//     return { userId: user.id, isPro };
//   } catch (error) {
//     if (error instanceof ChatSDKError) {
//       throw error;
//     }

//     console.error("Failed to get user session:", error);
//     throw new ChatSDKError("unauthorized:auth");
//   }
// };

/**
 * Get the current user ID and pro status from the authenticated session
 * Throws ChatSDKError if user is not authenticated
 *
 * @param req - NextRequest object (server-side only)
 * @returns Promise<{userId: string, isPro: boolean}> - Object with userId and isPro
 * @throws ChatSDKError - When user is not authenticated
 */
export const getUserIDAndPro = async (
  req: NextRequest,
): Promise<{ userId: string; isPro: boolean }> => {
  try {
    const { authkit } = await import("@workos-inc/authkit-nextjs");
    const { session } = await authkit(req);

    if (!session?.user?.id) {
      throw new ChatSDKError("unauthorized:auth");
    }

    // Check if user has pro entitlements
    const entitlements = session.entitlements || [];
    const isPro = entitlements.includes("pro-monthly-plan");

    return { userId: session.user.id, isPro };
  } catch (error) {
    if (error instanceof ChatSDKError) {
      throw error;
    }

    console.error("Failed to get user session:", error);
    throw new ChatSDKError("unauthorized:auth");
  }
};
