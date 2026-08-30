import {
  parseFirstTouchAttribution,
  type FirstTouchAttribution,
} from "@/lib/analytics/acquisition";

const SIGNUP_ATTRIBUTION_STATE_KIND = "hackerai_signup_acquisition_v1";

export type SignupAttributionState = {
  kind: typeof SIGNUP_ATTRIBUTION_STATE_KIND;
  signupStartedAt: string;
  firstTouch: FirstTouchAttribution;
};

export function createSignupAttributionState(
  firstTouch: FirstTouchAttribution,
  signupStartedAt = new Date(),
): string {
  return JSON.stringify({
    kind: SIGNUP_ATTRIBUTION_STATE_KIND,
    signupStartedAt: signupStartedAt.toISOString(),
    firstTouch,
  } satisfies SignupAttributionState);
}

export function parseSignupAttributionState(
  value: string | undefined,
): SignupAttributionState | null {
  if (!value || value.length > 4_096) return null;

  try {
    const parsed = JSON.parse(value) as Partial<SignupAttributionState>;
    const firstTouch = parseFirstTouchAttribution(
      encodeURIComponent(JSON.stringify(parsed.firstTouch)),
    );
    if (
      parsed.kind !== SIGNUP_ATTRIBUTION_STATE_KIND ||
      typeof parsed.signupStartedAt !== "string" ||
      !Number.isFinite(Date.parse(parsed.signupStartedAt)) ||
      !firstTouch
    ) {
      return null;
    }

    return {
      kind: SIGNUP_ATTRIBUTION_STATE_KIND,
      signupStartedAt: parsed.signupStartedAt,
      firstTouch,
    };
  } catch {
    return null;
  }
}
