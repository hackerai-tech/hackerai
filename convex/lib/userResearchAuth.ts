export const validateUserResearchServiceKey = (serviceKey: string): void => {
  const expected = process.env.CONVEX_USER_RESEARCH_SERVICE_KEY;
  if (!expected || serviceKey !== expected) {
    throw new Error("Unauthorized: Invalid user research service key");
  }
};
