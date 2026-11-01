// Developer-only, read-only browser diagnostic. Never reads input values or page text.
const defaults = ["https://hackerai.co", "https://signin.hackerai.co"];
const signalKeys = [
  "password",
  "email",
  "verification",
  "challenge",
  "sessionUi",
];

export function classifyLoginSignals(signals) {
  if (
    !signals ||
    typeof signals !== "object" ||
    Array.isArray(signals) ||
    Object.keys(signals).length !== signalKeys.length ||
    !signalKeys.every(
      (key) => Object.hasOwn(signals, key) && typeof signals[key] === "boolean",
    )
  ) {
    return "unavailable";
  }
  if (signals.challenge) return "challenge";
  if (signals.verification) return "verification-required";
  if (signals.password) return "password-entry";
  if (signals.email) return "email-entry";
  // A UI marker is not proof of the authenticated identity or entitlement.
  if (signals.sessionUi) return "session-ui-present";
  return "unknown";
}

// This function runs inside the browser's read-only DOM scope. Keep its return shape fixed.
export function readLoginSignals() {
  const present = (selector) => document.querySelector(selector) !== null;
  return {
    password: present('input[type="password"]'),
    email: present('input[type="email"], input[autocomplete="username"]'),
    verification:
      present(
        'input[autocomplete="one-time-code"], input[name="code"], input[name="otp"], input[name="recovery_code"], input[name="recoveryCode"]',
      ) ||
      document.querySelectorAll('input[inputmode="numeric"][maxlength="1"]')
        .length >= 4,
    challenge: present(
      'iframe[src*="recaptcha"], iframe[src*="hcaptcha"], iframe[src*="challenges.cloudflare.com"], [data-sitekey]',
    ),
    sessionUi: present(
      '[data-testid="user-menu"], button[aria-label="Open user menu"]',
    ),
  };
}

export async function diagnoseLogin(
  tab,
  { allowedOrigins = defaults, timeoutMs = 3_000 } = {},
) {
  if (
    !Array.isArray(allowedOrigins) ||
    allowedOrigins.length < 1 ||
    allowedOrigins.length > 8 ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 10 ||
    timeoutMs > 10_000
  ) {
    return { origin: null, state: "unavailable" };
  }
  const allowed = new Set();
  try {
    for (const raw of allowedOrigins) {
      const u = new URL(raw);
      if (
        !["https:", "http:"].includes(u.protocol) ||
        u.username ||
        u.password ||
        u.origin !== raw
      )
        throw new Error();
      allowed.add(u.origin);
    }
  } catch {
    return { origin: null, state: "unavailable" };
  }
  let timer;
  const inspect = async () => {
    try {
      const before = await tab.url();
      const url = new URL(before);
      if (url.username || url.password || !allowed.has(url.origin))
        return { origin: null, state: "unsupported-origin" };
      const signals = await tab.playwright.evaluate(
        readLoginSignals,
        undefined,
        { timeoutMs },
      );
      if (before !== (await tab.url()))
        return { origin: null, state: "page-changed" };
      return { origin: url.origin, state: classifyLoginSignals(signals) };
    } catch {
      // Tool errors may embed URLs, input arguments, HTML, or codes. Never propagate them.
      return { origin: null, state: "unavailable" };
    }
  };
  try {
    return await Promise.race([
      inspect(),
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ origin: null, state: "unavailable" }),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
