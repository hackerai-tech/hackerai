/** The retired Agent limiter used UTC-day buckets; stale keys may lack a TTL. */
export const isExpiredLegacyFreeAgentWindow = (
  key: string,
  now = Date.now(),
): boolean => {
  const match = /^free_agent_limit:user_[A-Z0-9]{26}:free_agent:(\d+)$/.exec(
    key,
  );
  if (!match) return false;
  const bucket = Number(match[1]);
  return (
    Number.isSafeInteger(bucket) &&
    bucket >= 0 &&
    bucket < Math.floor(now / 86_400_000)
  );
};

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
    key === `free_usage_budget_started:v1:${freeQuotaSubject}` ||
    key === `free_run_lock:${freeQuotaSubject}`
  );
};

export const isUserRateLimitKey = (key: string, userId: string): boolean => {
  return (
    key.startsWith(`usage:monthly:${userId}:`) ||
    key === `upgrade:carryover:${userId}` ||
    key.startsWith(`upgrade:carryover:${userId}:`) ||
    isFreeQuotaSubjectRateLimitKey(key, userId) ||
    (key.startsWith("team:debt_applied:") && key.endsWith(`:${userId}`))
  );
};
