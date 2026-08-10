jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
  },
}));

import type { User } from "@workos-inc/node";
import { phLogger } from "@/lib/posthog/server";
import {
  captureUserEmailVerified,
  captureUserSignedUp,
} from "@/lib/analytics/user-signup";

const mockPhEvent = phLogger.event as jest.MockedFunction<
  typeof phLogger.event
>;

describe("WorkOS user analytics", () => {
  beforeEach(() => {
    mockPhEvent.mockClear();
  });

  test("records email verification as creation-time signup state", () => {
    captureUserSignedUp({
      user: {
        id: "user-1",
        emailVerified: false,
        locale: "en-US",
        createdAt: "2026-08-07T12:00:00.000Z",
      } as User,
      workosEventId: "event-created-1",
      workosEventCreatedAt: "2026-08-07T12:00:01.000Z",
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "user_signed_up",
      expect.objectContaining({
        userId: "user-1",
        email_verified: false,
        email_verified_at_creation: false,
        $set_once: expect.objectContaining({
          email_verified_at_creation: false,
        }),
      }),
    );
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("$set");
  });

  test("sets verified person state only when it was already true at creation", () => {
    captureUserSignedUp({
      user: {
        id: "user-2",
        emailVerified: true,
        locale: "en-US",
        createdAt: "2026-08-07T13:00:00.000Z",
      } as User,
      workosEventId: "event-created-2",
      workosEventCreatedAt: "2026-08-07T13:00:01.000Z",
    });

    expect(mockPhEvent).toHaveBeenCalledWith(
      "user_signed_up",
      expect.objectContaining({
        email_verified_at_creation: true,
        $set: {
          email_verified: true,
          email_verified_at: "2026-08-07T13:00:00.000Z",
        },
      }),
    );
  });

  test("records a privacy-safe verification transition and updates person state", () => {
    captureUserEmailVerified({
      userId: "user-1",
      workosEventId: "event-verified-1",
      workosEventCreatedAt: "2026-08-07T12:05:00.000Z",
    });

    expect(mockPhEvent).toHaveBeenCalledWith("user_email_verified", {
      userId: "user-1",
      verification_source: "workos_authentication_email_verification_succeeded",
      email_verified: true,
      email_verified_at: "2026-08-07T12:05:00.000Z",
      workos_event_id: "event-verified-1",
      workos_event_created_at: "2026-08-07T12:05:00.000Z",
      $insert_id: "event-verified-1",
      $set: {
        email_verified: true,
        email_verified_at: "2026-08-07T12:05:00.000Z",
      },
    });

    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("email");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("ip_address");
    expect(mockPhEvent.mock.calls[0]?.[1]).not.toHaveProperty("user_agent");
  });
});
