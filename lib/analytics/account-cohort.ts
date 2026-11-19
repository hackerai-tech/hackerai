export type AnalyticsAccountCohort = "internal" | "non_internal" | "unknown";

/** Domain classification from authenticated account data, never authorization or proof of a customer. */
export function analyticsAccountCohort(email: unknown): AnalyticsAccountCohort {
  if (typeof email !== "string") return "unknown";
  const normalized = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(normalized)) return "unknown";
  return /@hackerai\.(com|co)$/.test(normalized) ? "internal" : "non_internal";
}
