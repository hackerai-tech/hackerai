import {
  isCaptchaEligible,
  captchaFlag,
  captchaAutomaticSolvingEnabled,
  CAPTCHA_SOLVER_FLAG,
  CAPTCHA_PREVIEW_FLAG,
} from "../policy";
const originalEnv = process.env;
afterEach(() => {
  process.env = originalEnv;
});

it("requires independent trusted environment, enablement and user targeting", () => {
  const env = {
    HACKERAI_CAPTCHA_SOLVER_ENABLED: "1",
    CAPTCHA_SOLVER_USER_IDS: " first, second ",
  };
  expect(isCaptchaEligible("PREVIEW", "second", env)).toBe(true);
  expect(isCaptchaEligible("PRODUCTION", "second", env)).toBe(true);
  expect(isCaptchaEligible("PRODUCTION", "other", env)).toBe(false);
  for (const runtime of [undefined, "production", "DEVELOPMENT", "STAGING"])
    expect(isCaptchaEligible(runtime, "first", env)).toBe(false);
  expect(
    isCaptchaEligible("PRODUCTION", "first", {
      ...env,
      CAPTCHA_SOLVER_USER_IDS: undefined,
    }),
  ).toBe(false);
});

it("never enables Production from legacy Preview settings, and explicit off overrides legacy on", () => {
  const legacy = {
    HACKERAI_CAPTCHA_SOLVER_PREVIEW: "1",
    HACKERAI_CAPTCHA_AUTO_SOLVE_PREVIEW: "1",
    CAPTCHA_SOLVER_PREVIEW_USER_IDS: "user",
  };
  expect(isCaptchaEligible("PREVIEW", "user", legacy)).toBe(true);
  expect(isCaptchaEligible("PRODUCTION", "user", legacy)).toBe(false);
  process.env = legacy;
  expect(captchaFlag("PREVIEW")).toBe(CAPTCHA_PREVIEW_FLAG);
  process.env = { ...legacy, HACKERAI_CAPTCHA_SOLVER_ENABLED: "0" };
  expect(isCaptchaEligible("PREVIEW", "user")).toBe(false);
  expect(captchaAutomaticSolvingEnabled("PREVIEW")).toBe(false);
  expect(captchaFlag("PREVIEW")).toBe(CAPTCHA_SOLVER_FLAG);
});
