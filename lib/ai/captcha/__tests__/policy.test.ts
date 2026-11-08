import { isCaptchaEligible } from "../policy";

it("limits eligibility to trusted Preview and Production workers without env opt-ins", () => {
  expect(isCaptchaEligible("PREVIEW")).toBe(true);
  expect(isCaptchaEligible("PRODUCTION")).toBe(true);
  for (const runtime of [undefined, "production", "DEVELOPMENT", "STAGING"])
    expect(isCaptchaEligible(runtime)).toBe(false);
});
