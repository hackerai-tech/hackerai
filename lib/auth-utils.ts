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
