export const isFreeQuotaSubjectRateLimitKey = (
  key: string,
  freeQuotaSubject: string,
): boolean => {
  return (
    key.startsWith(`free_limit:${freeQuotaSubject}:`) ||
    key === `free_referral_bonus:${freeQuotaSubject}` ||
    (key.startsWith("free_referral_bonus_grant:") &&
      key.endsWith(`:${freeQuotaSubject}`)) ||
    key.startsWith(`free_agent_limit:${freeQuotaSubject}:`) ||
    key.startsWith(`free_monthly_cost:${freeQuotaSubject}:`) ||
    key === `free_run_lock:${freeQuotaSubject}`
  );
};

export const isUserRateLimitKey = (key: string, userId: string): boolean => {
  return (
    key.startsWith(`usage:monthly:${userId}:`) ||
    key === `upgrade:carryover:${userId}` ||
    isFreeQuotaSubjectRateLimitKey(key, userId) ||
    (key.startsWith("team:debt_applied:") && key.endsWith(`:${userId}`))
  );
};
