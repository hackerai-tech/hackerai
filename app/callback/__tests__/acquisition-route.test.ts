import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const mockHandleAuth = jest.fn(() => jest.fn());
const mockCapture = jest.fn();
const mockAfter = jest.fn();
const mockFlush = jest.fn();

jest.mock("@workos-inc/authkit-nextjs", () => ({
  handleAuth: mockHandleAuth,
}));
jest.mock("next/server", () => ({
  after: mockAfter,
  NextResponse: {
    redirect: jest.fn(),
  },
}));
jest.mock("next/headers", () => ({
  cookies: jest.fn(),
}));
jest.mock("@/lib/analytics/signup-acquisition", () => ({
  captureSignupAcquisitionAttribution: mockCapture,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { flush: mockFlush },
}));

describe("AuthKit callback acquisition handoff", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
  });

  it("captures and flushes valid signup attribution after authentication", async () => {
    mockCapture.mockReturnValue(true);
    await import("../route");
    const options = mockHandleAuth.mock.calls[0]?.[0] as {
      onSuccess: (input: {
        user: { id: string };
        state: string;
      }) => Promise<void>;
    };

    await options.onSuccess({ user: { id: "user_new" }, state: "state" });

    expect(mockCapture).toHaveBeenCalledWith({
      user: { id: "user_new" },
      state: "state",
    });
    expect(mockAfter).toHaveBeenCalledTimes(1);
    const flush = mockAfter.mock.calls[0]?.[0] as () => Promise<void>;
    await flush();
    expect(mockFlush).toHaveBeenCalledTimes(1);
  });

  it("does not schedule a flush when no signup attribution was captured", async () => {
    mockCapture.mockReturnValue(false);
    await import("../route");
    const options = mockHandleAuth.mock.calls[0]?.[0] as {
      onSuccess: (input: {
        user: { id: string };
        state?: string;
      }) => Promise<void>;
    };

    await options.onSuccess({ user: { id: "user_existing" } });

    expect(mockAfter).not.toHaveBeenCalled();
  });
});
