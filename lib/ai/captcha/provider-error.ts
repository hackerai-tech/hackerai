/** A terminal provider result, never a timeout or an uncertain task outcome. */
export class CaptchaUnsolvableError extends Error {
  constructor() {
    super("The provider could not solve this CAPTCHA.");
    this.name = "CaptchaUnsolvableError";
  }
}
