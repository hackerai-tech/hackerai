export const ACCOUNT_CLEANUP_IN_PROGRESS_CODE = "account_cleanup_in_progress";

// Each server request keeps Convex work below its existing 50-mutation bound.
// Ten requests fit inside the route's recent-login window even when a batch
// pass takes roughly the 47-48 seconds observed in production.
export const MAX_ACCOUNT_CLEANUP_REQUESTS = 10;
