import { validPartnerCode } from "./policy";

// Analytics-only handoff. Never use this unsigned cookie for attribution.
export const INFLUENCER_VISIT_COOKIE = "hackerai_partner_visit";
export const VISIT_HANDOFF_SECONDS = 300;
export const INFLUENCER_VISIT_EVENT = "influencer_link_visited";

export type InfluencerVisit = {
  code: string;
  visitorId: string;
  visitId: string;
  timestamp: number;
  environment: string;
};

const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

export function parseInfluencerVisit(
  value: string | undefined,
): InfluencerVisit | null {
  if (!value || value.length > 600) return null;
  try {
    const visit = JSON.parse(decodeURIComponent(value));
    if (
      !visit ||
      typeof visit.code !== "string" ||
      !validPartnerCode(visit.code) ||
      typeof visit.visitorId !== "string" ||
      !uuid.test(visit.visitorId) ||
      typeof visit.visitId !== "string" ||
      !uuid.test(visit.visitId) ||
      !Number.isSafeInteger(visit.timestamp) ||
      visit.timestamp <= 0 ||
      Number.isNaN(new Date(visit.timestamp).getTime()) ||
      !["production", "preview", "development", "test"].includes(
        visit.environment,
      )
    )
      return null;
    // Cookie Max-Age owns expiry; the browser clock may differ from the server.
    return {
      code: visit.code,
      visitorId: visit.visitorId,
      visitId: visit.visitId,
      timestamp: visit.timestamp,
      environment: visit.environment,
    };
  } catch {
    return null;
  }
}
