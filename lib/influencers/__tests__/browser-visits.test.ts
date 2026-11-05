import {
  captureInfluencerVisit,
  clearInfluencerVisit,
  pendingInfluencerVisit,
  sanitizeInfluencerVisit,
} from "../browser-visits";
import { INFLUENCER_VISIT_COOKIE } from "../visit-handoff";
import type { PostHog } from "posthog-js";

const visit = () => ({
  code: "medusa",
  visitorId: "00000000-0000-4000-8000-000000000001",
  visitId: "00000000-0000-4000-8000-000000000002",
  timestamp: Date.now(),
  environment: "preview",
});
const store = (value: unknown) => {
  document.cookie = `${INFLUENCER_VISIT_COOKIE}=${encodeURIComponent(JSON.stringify(value))}; Path=/`;
};

afterEach(() => {
  clearInfluencerVisit();
  jest.restoreAllMocks();
});

it.each([
  { code: "../invalid" },
  { visitorId: "account-id" },
  { visitId: "bad" },
  { timestamp: 0 },
  { timestamp: Number.MAX_SAFE_INTEGER },
  { environment: "unknown" },
])("rejects malformed telemetry %s", (overrides) => {
  store({ ...visit(), ...overrides });
  const capture = jest.fn();
  captureInfluencerVisit({ capture } as unknown as PostHog);
  expect(capture).not.toHaveBeenCalled();
});

it("drops a consumed visit if the SDK fails, without replaying it on reload", () => {
  store(visit());
  const capture = jest.fn(() => {
    throw new Error("offline");
  });
  expect(() =>
    captureInfluencerVisit({ capture } as unknown as PostHog),
  ).not.toThrow();
  expect(pendingInfluencerVisit()).toBeNull();
});

it("does not capture crawler arrivals", () => {
  store(visit());
  jest.spyOn(navigator, "userAgent", "get").mockReturnValue("SearchBot");
  const capture = jest.fn();
  captureInfluencerVisit({ capture } as unknown as PostHog);
  expect(capture).not.toHaveBeenCalled();
  expect(pendingInfluencerVisit()).toBeNull();
});

it("strips account, device and URL enrichment and forces person processing off", () => {
  const event = sanitizeInfluencerVisit({
    properties: {
      token: "public-project-token",
      distinct_id: "influencer-visitor:one",
      influencer_code: "medusa",
      $process_person_profile: true,
      $current_url: "https://example.com/private",
      $device_id: "device",
      $session_id: "session",
      email: "private@example.com",
      $user_id: "user",
    },
    $set: { email: "private@example.com" },
    $set_once: { source: "private" },
  });
  expect(event).toEqual({
    properties: {
      token: "public-project-token",
      distinct_id: "influencer-visitor:one",
      influencer_code: "medusa",
      $process_person_profile: false,
      $geoip_disable: true,
    },
  });
});

it("preserves server time when the browser clock is behind", () => {
  const arrival = visit();
  store(arrival);
  jest.spyOn(Date, "now").mockReturnValue(arrival.timestamp - 60_000);
  const capture = jest.fn();
  captureInfluencerVisit({ capture } as unknown as PostHog);
  expect(capture).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    uuid: arrival.visitId,
    timestamp: new Date(arrival.timestamp),
  });
});

it("preserves the funnel identity through real SDK enrichment without changing the signed-in identity", () => {
  jest.useFakeTimers();
  const { PostHog: SDK } = jest.requireActual("posthog-js");
  const sdk = new SDK();
  // Network is the only mocked SDK boundary. Inspect the real enriched event.
  jest.spyOn(sdk, "_send_request").mockImplementation(() => {});
  const sent: unknown[] = [];
  try {
    sdk.init("phc_synthetic", {
      persistence: "memory",
      autocapture: false,
      capture_pageview: false,
      capture_pageleave: false,
      disable_session_recording: true,
      advanced_disable_decide: true,
      advanced_disable_feature_flags: true,
      before_send: (event: {
        event: string;
        properties: Record<string, unknown>;
      }) => {
        if (event.event === "influencer_link_visited")
          sent.push(sanitizeInfluencerVisit(event));
        return null;
      },
    });
    sdk.identify("existing-account", { email: "private@example.com" });
    sdk.register({ private_context: "private" });
    const arrival = visit();
    store(arrival);
    captureInfluencerVisit(sdk);
    expect(sdk.get_distinct_id()).toBe("existing-account");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual(
      expect.objectContaining({
        properties: {
          token: "phc_synthetic",
          distinct_id: `influencer-visitor:${arrival.visitorId}`,
          $insert_id: arrival.visitId,
          influencer_code: "medusa",
          referral_program: "influencer",
          analytics_version: 1,
          environment: "preview",
          $process_person_profile: false,
          $geoip_disable: true,
        },
      }),
    );
    expect(JSON.stringify(sent)).not.toMatch(
      /existing-account|private@example|private_context/,
    );
  } finally {
    sdk.opt_out_capturing();
    jest.clearAllTimers();
    jest.useRealTimers();
  }
});
