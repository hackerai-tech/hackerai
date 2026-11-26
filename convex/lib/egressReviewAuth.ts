/**
 * The automated egress review's switch and dedicated key, which must differ
 * from the general and research service keys. Shared by the review module and
 * the reassessment action that the same key authorizes.
 */
export function authorizeEgressReview(serviceKey: string) {
  const expected = process.env.CONVEX_EGRESS_ABUSE_REVIEW_SERVICE_KEY;
  if (
    process.env.E2B_EGRESS_ABUSE_REVIEW_ENABLED !== "true" ||
    !expected ||
    serviceKey !== expected ||
    expected === process.env.CONVEX_SERVICE_ROLE_KEY ||
    expected === process.env.CONVEX_USER_RESEARCH_SERVICE_KEY
  )
    throw new Error("Unauthorized: Invalid egress abuse review service key");
}
