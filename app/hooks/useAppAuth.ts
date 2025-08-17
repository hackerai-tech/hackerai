import { useAuth } from "@workos-inc/authkit-nextjs/components";
import { isWorkOSEnabled } from "@/lib/auth-utils";

/**
 * Custom hook that handles authentication for both WorkOS and anonymous modes
 * Returns consistent user/loading state regardless of auth mode
 */
export const useAppAuth = () => {
  if (isWorkOSEnabled()) {
    return useAuth();
  }

  // Anonymous mode - no authentication required
  return { user: null, loading: false };
};
