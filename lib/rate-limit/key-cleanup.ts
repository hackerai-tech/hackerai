export const isUserRateLimitKey = (key: string, userId: string): boolean => {
  return (
    key.startsWith(`usage:monthly:${userId}:`) ||
    key === `upgrade:carryover:${userId}` ||
    key.startsWith(`free_limit:${userId}:`) ||
    key === `free_referral_bonus:${userId}` ||
    (key.startsWith("free_referral_bonus_grant:") &&
      key.endsWith(`:${userId}`)) ||
    key.startsWith(`free_agent_limit:${userId}:`) ||
    key.startsWith(`free_monthly_cost:${userId}:`) ||
    key === `free_run_lock:${userId}` ||
    (key.startsWith("team:debt_applied:") && key.endsWith(`:${userId}`))
  );
};
