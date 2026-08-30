import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import type { User } from "@workos-inc/node";
import { phLogger } from "@/lib/posthog/server";
import type { FirstTouchAttribution } from "../acquisition";
import {
  acquisitionSourceBucket,
  captureSignupAcquisitionAttribution,
} from "../signup-acquisition";
import { createSignupAttributionState } from "../signup-acquisition-state";

const mockPhEvent = jest
  .spyOn(phLogger, "event")
  .mockImplementation(() => undefined);

describe("signup acquisition attribution", () => {
  const now = new Date("2026-08-30T12:05:00.000Z");
  const firstTouch: FirstTouchAttribution = {
    version: 1,
    source: "github",
    medium: "social",
    campaign: "aug_launch",
    referringDomain: "github.com",
    entrySurface: "home",
    capturedAt: "2026-08-29T12:00:00.000Z",
  };

  beforeEach(() => {
    mockPhEvent.mockClear();
  });

  it.each([
    ["google", "organic", "google.com", "home", "organic_search"],
    ["user_referral", "referral", "$direct", "invite", "referral_link"],
    ["github", "social", "github.com", "home", "github"],
    ["reddit.com", "referral", "reddit.com", "home", "community"],
    ["chatgpt.com", "referral", "chatgpt.com", "home", "ai_assistant"],
    ["newsletter", "email", "$direct", "home", "campaign"],
    ["$direct", "none", "$direct", "home", "direct_or_dark"],
    ["partner.example", "referral", "partner.example", "home", "unknown"],
  ] as const)(
    "buckets %s / %s as %s",
    (source, medium, referringDomain, entrySurface, expected) => {
      expect(
        acquisitionSourceBucket({
          ...firstTouch,
          source,
          medium,
          referringDomain,
          entrySurface,
          campaign: undefined,
        }),
      ).toBe(expected);
    },
  );

  it("emits one idempotent privacy-safe event for a newly created signup", () => {
    const state = createSignupAttributionState(
      firstTouch,
      new Date("2026-08-30T12:00:00.000Z"),
    );
    const captured = captureSignupAcquisitionAttribution({
      user: {
        id: "user_new",
        createdAt: "2026-08-30T12:01:00.000Z",
      } as User,
      state,
      now,
    });

    expect(captured).toBe(true);
    expect(mockPhEvent).toHaveBeenCalledWith(
      "signup_acquisition_attributed_v1",
      {
        userId: "user_new",
        acquisition_attribution_version: 1,
        acquisition_source_bucket: "github",
        attribution_source: "workos_authkit_callback",
        referral_link_present: false,
        signup_started_at: "2026-08-30T12:00:00.000Z",
        user_created_at: "2026-08-30T12:01:00.000Z",
        first_touch_attribution_version: 1,
        first_touch_source: "github",
        first_touch_medium: "social",
        first_touch_campaign: "aug_launch",
        first_touch_referring_domain: "github.com",
        first_touch_entry_surface: "home",
        first_touch_captured_at: "2026-08-29T12:00:00.000Z",
        $insert_id: "signup_acquisition_attributed_v1:user_new",
        $set_once: {
          acquisition_source_bucket: "github",
          referral_link_present: false,
          first_touch_attribution_version: 1,
          first_touch_source: "github",
          first_touch_medium: "social",
          first_touch_campaign: "aug_launch",
          first_touch_referring_domain: "github.com",
          first_touch_entry_surface: "home",
          first_touch_captured_at: "2026-08-29T12:00:00.000Z",
        },
      },
    );
    expect(JSON.stringify(mockPhEvent.mock.calls[0])).not.toContain("email");
    expect(JSON.stringify(mockPhEvent.mock.calls[0])).not.toContain("http");
  });

  it("does not attribute an existing user who enters through the signup screen", () => {
    const state = createSignupAttributionState(
      firstTouch,
      new Date("2026-08-30T12:00:00.000Z"),
    );

    expect(
      captureSignupAcquisitionAttribution({
        user: {
          id: "user_existing",
          createdAt: "2026-01-01T00:00:00.000Z",
        } as User,
        state,
        now,
      }),
    ).toBe(false);
    expect(mockPhEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing state", undefined],
    ["malformed state", "not-json"],
    [
      "expired auth flow",
      createSignupAttributionState(
        firstTouch,
        new Date("2026-08-30T11:00:00.000Z"),
      ),
    ],
    [
      "expired first touch",
      createSignupAttributionState(
        { ...firstTouch, capturedAt: "2026-01-01T00:00:00.000Z" },
        new Date("2026-08-30T12:00:00.000Z"),
      ),
    ],
  ])("ignores %s", (_label, state) => {
    expect(
      captureSignupAcquisitionAttribution({
        user: {
          id: "user_new",
          createdAt: "2026-08-30T12:01:00.000Z",
        } as User,
        state,
        now,
      }),
    ).toBe(false);
    expect(mockPhEvent).not.toHaveBeenCalled();
  });
});
