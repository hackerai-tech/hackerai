import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { isWorkOSEnabled } from "@/lib/auth/client";

/**
 * Custom hook that handles authentication for both WorkOS and anonymous modes
 * Returns consistent user/loading state regardless of auth mode
 */
export const useAppAuth = () => {
  // Always call useAuth to comply with rules of hooks
  const workosAuth = useAuth();

  if (isWorkOSEnabled()) {
    return workosAuth;
  }

  // Anonymous mode - no authentication required
  return { user: null, loading: false };
};
