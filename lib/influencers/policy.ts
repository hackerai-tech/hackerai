export const INFLUENCER_COOKIE = "hackerai_partner";
export const ATTRIBUTION_DAYS = 30;
export const PAYOUT_HOLD_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_MONTHLY_BPS = 1500;
export const DEFAULT_ANNUAL_BPS = 1000;

export function validPartnerCode(code: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,23}$/.test(code);
}

export function anniversary(timestamp: number): number {
  const date = new Date(timestamp);
  const month = date.getUTCMonth();
  date.setUTCFullYear(date.getUTCFullYear() + 1);
  if (date.getUTCMonth() !== month) date.setUTCDate(0);
  return date.getTime();
}

export function commissionCents(netCents: number, rateBps: number): number {
  if (
    !Number.isSafeInteger(netCents) ||
    netCents < 0 ||
    !Number.isInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > 10_000
  ) {
    throw new Error("Invalid commission amount or rate");
  }
  return Number((BigInt(netCents) * BigInt(rateBps)) / BigInt(10_000));
}
