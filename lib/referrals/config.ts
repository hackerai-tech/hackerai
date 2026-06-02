export const REFERRAL_COOKIE_NAME = "hackerai_ref";
export const REFERRAL_COOKIE_CREATED_AT_NAME = "hackerai_ref_at";

export const REFERRAL_CODE_PATTERN = /^[a-zA-Z0-9_-]{6,64}$/;

export type ReferralRewardConfig = {
  enabled: boolean;
  referrerRewardDollars: number;
  referredSignupBonusUnits: number;
  attributionMaxUserAgeDays: number;
  cookieMaxAgeSeconds: number;
};

const parsePositiveNumber = (
  raw: string | undefined,
  fallback: number,
): number => {
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export function getReferralRewardConfig(): ReferralRewardConfig {
  return {
    enabled: process.env.REFERRAL_PROGRAM_ENABLED !== "false",
    referrerRewardDollars: parsePositiveNumber(
      process.env.REFERRAL_REFERRER_REWARD_DOLLARS,
      10,
    ),
    referredSignupBonusUnits: parsePositiveNumber(
      process.env.REFERRAL_REFERRED_SIGNUP_BONUS_UNITS,
      10,
    ),
    attributionMaxUserAgeDays: parsePositiveNumber(
      process.env.REFERRAL_ATTRIBUTION_MAX_USER_AGE_DAYS,
      7,
    ),
    cookieMaxAgeSeconds: Math.round(
      parsePositiveNumber(process.env.REFERRAL_COOKIE_MAX_AGE_DAYS, 30) *
        24 *
        60 *
        60,
    ),
  };
}

export function isValidReferralCode(code: string | null | undefined): boolean {
  return typeof code === "string" && REFERRAL_CODE_PATTERN.test(code);
}
