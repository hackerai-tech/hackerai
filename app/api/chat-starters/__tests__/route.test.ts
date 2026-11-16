import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn<(req: NextRequest) => Promise<string>>();
const mockGetFlag =
  jest.fn<
    (flagKey: string, userId: string) => Promise<boolean | string | null>
  >();

jest.mock("next/server", () => ({}));
jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: (req: NextRequest) => mockGetUserID(req),
}));
jest.mock("@/lib/posthog/server", () => ({
  getPostHogFeatureFlagRawValueForUser: (flagKey: string, userId: string) =>
    mockGetFlag(flagKey, userId),
}));

class MockResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  constructor(
    private body: unknown,
    init?: { status?: number; headers?: Record<string, string> },
  ) {
    this.status = init?.status ?? 200;
    this.headers = init?.headers ?? {};
  }
  static json(
    body: unknown,
    init?: { status?: number; headers?: Record<string, string> },
  ) {
    return new MockResponse(body, init);
  }
  async json() {
    return this.body;
  }
}
Object.defineProperty(globalThis, "Response", {
  configurable: true,
  value: MockResponse,
});

const { GET } = require("../route") as typeof import("../route");
const request = {} as NextRequest;
const read = async (response: Response) => {
  const mock = response as unknown as MockResponse;
  return {
    status: mock.status,
    cacheControl: mock.headers["Cache-Control"],
    body: await mock.json(),
  };
};

describe("GET /api/chat-starters", () => {
  beforeEach(() => {
    mockGetUserID.mockReset().mockResolvedValue("user-1");
    mockGetFlag.mockReset();
  });

  it("enables starters only for the authenticated user's boolean true flag", async () => {
    mockGetFlag.mockResolvedValue(true);

    expect(await read(await GET(request))).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      body: { enabled: true },
    });
    expect(mockGetFlag).toHaveBeenCalledWith("chat_starters_v1", "user-1");
  });

  it.each([false, null, "test", "true"])(
    "fails closed for a %p flag value",
    async (value) => {
      mockGetFlag.mockResolvedValue(value);

      expect(await read(await GET(request))).toEqual({
        status: 200,
        cacheControl: "private, no-store",
        body: { enabled: false },
      });
    },
  );

  it("fails closed quietly when the flag lookup throws", async () => {
    mockGetFlag.mockRejectedValue(new Error("posthog unavailable"));

    expect(await read(await GET(request))).toEqual({
      status: 200,
      cacheControl: "private, no-store",
      body: { enabled: false },
    });
  });

  it("rejects unauthenticated requests without evaluating the flag", async () => {
    mockGetUserID.mockRejectedValue(new ChatSDKError("unauthorized:auth"));

    expect(await read(await GET(request))).toEqual({
      status: 401,
      cacheControl: "private, no-store",
      body: { enabled: false },
    });
    expect(mockGetFlag).not.toHaveBeenCalled();
  });
});
