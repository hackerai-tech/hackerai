export const CAPTCHA_SOLVER_FLAG = "browser_captcha_solver_v1";

/** Trigger supplies the trusted runtime; PostHog owns rollout and user targeting. */
export function isCaptchaEligible(environment: string | undefined): boolean {
  return environment === "PREVIEW" || environment === "PRODUCTION";
}
