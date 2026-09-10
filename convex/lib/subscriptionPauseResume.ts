/**
 * Resume claims at or above this version participate in the deletion barrier.
 * Older in-flight claims fail closed during rolling deployments.
 */
export const DELETION_COORDINATED_RESUME_CLAIM_VERSION = 2;
