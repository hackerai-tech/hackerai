export const CAPTCHA_PREVIEW_FLAG = "browser_captcha_solver_preview_v1";

/** Trigger's trusted execution environment, never a model/tool input. */
export function isCaptchaPreviewEligible(
  environment: string | undefined,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return (
    environment === "PREVIEW" &&
    env.HACKERAI_CAPTCHA_SOLVER_PREVIEW === "1" &&
    env.CAPTCHA_SOLVER_PREVIEW_USER_IDS?.split(",")
      .map((id) => id.trim())
      .includes(userId) === true
  );
}
