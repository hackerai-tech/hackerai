export const CAPTCHA_PREVIEW_FLAG = "browser_captcha_solver_preview_v1";

/** Trigger's trusted execution environment, never a model/tool input. */
export function isCaptchaEligible(
  environment: string | undefined,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.HACKERAI_CAPTCHA_SOLVER_ENABLED !== undefined) {
    return (
      (environment === "PREVIEW" || environment === "PRODUCTION") &&
      env.HACKERAI_CAPTCHA_SOLVER_ENABLED === "1" &&
      env.CAPTCHA_SOLVER_USER_IDS?.split(",")
        .map((id) => id.trim())
        .includes(userId) === true
    );
  }
  return (
    environment === "PREVIEW" &&
    env.HACKERAI_CAPTCHA_SOLVER_PREVIEW === "1" &&
    env.CAPTCHA_SOLVER_PREVIEW_USER_IDS?.split(",")
      .map((id) => id.trim())
      .includes(userId) === true
  );
}

export const CAPTCHA_SOLVER_FLAG = "browser_captcha_solver_v1";

export function captchaFlag(environment: string | undefined): string {
  return environment === "PREVIEW" &&
    process.env.HACKERAI_CAPTCHA_SOLVER_ENABLED === undefined
    ? CAPTCHA_PREVIEW_FLAG
    : CAPTCHA_SOLVER_FLAG;
}

export function captchaAutomaticSolvingEnabled(
  environment: string | undefined,
): boolean {
  if (process.env.HACKERAI_CAPTCHA_SOLVER_ENABLED !== undefined)
    return process.env.HACKERAI_CAPTCHA_SOLVER_ENABLED === "1";
  return (
    process.env.HACKERAI_CAPTCHA_SOLVER_ENABLED === "1" ||
    (environment === "PREVIEW" &&
      process.env.HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW === "1")
  );
}
