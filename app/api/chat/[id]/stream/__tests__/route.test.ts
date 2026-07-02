import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import { ChatSDKError } from "@/lib/errors";

const mockGetUserID = jest.fn();
const mockGetChatById = jest.fn();
const mockAssertUserCanAccessChatHistory = jest.fn();

jest.mock("ai", () => ({
  createUIMessageStream: jest.fn(),
  JsonToSseTransformStream: jest.fn(),
}));

jest.mock("@/lib/api/chat-handler", () => ({
  getStreamContext: jest.fn(() => null),
}));

jest.mock("@/lib/auth/get-user-id", () => ({
  getUserID: mockGetUserID,
}));

jest.mock("@/lib/db/actions", () => ({
  getChatById: mockGetChatById,
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(() => ({
    mutation: jest.fn(),
    query: jest.fn(),
  })),
}));

jest.mock("@/convex/_generated/api", () => ({
  api: {
    chatStreams: {
      prepareForNewStream: "prepareForNewStream",
    },
  },
}));

jest.mock("@/lib/utils/stream-cancellation", () => ({
  createCancellationSubscriber: jest.fn(),
  createPreemptiveTimeout: jest.fn(),
}));

jest.mock("@/lib/posthog/server", () => ({
  phLogger: {
    event: jest.fn(),
  },
}));

jest.mock("@/lib/suspensions", () => ({
  assertUserCanAccessChatHistory: mockAssertUserCanAccessChatHistory,
}));

const request = {} as any;
const paramsFor = (id = "chat-1") => ({
  params: Promise.resolve({ id }),
});

function installResponseShim() {
  (globalThis as any).Response = {
    json: (body: unknown, init?: ResponseInit) => ({
      status: init?.status ?? 200,
      json: async () => body,
      text: async () =>
        typeof body === "string" ? body : JSON.stringify(body ?? ""),
    }),
  };
}

describe("GET /api/chat/[id]/stream", () => {
  let errorSpy: jest.SpiedFunction<typeof console.error>;

  beforeEach(() => {
    installResponseShim();
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    mockGetUserID.mockResolvedValue("user-1" as never);
    mockAssertUserCanAccessChatHistory.mockResolvedValue(undefined as never);
    mockGetChatById.mockResolvedValue({
      id: "chat-1",
      user_id: "user-1",
    } as never);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it("preserves transient database errors instead of returning chat not found", async () => {
    const { GET } = await import("../route");
    mockGetChatById.mockRejectedValue(
      new ChatSDKError(
        "offline:database",
        "Database temporarily unavailable: chats.getChatById: fetch failed",
      ) as never,
    );

    const response = await GET(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toEqual({
      code: "",
      message: "Something went wrong. Please try again later.",
    });
  });

  it("returns chat not found when the chat row is absent", async () => {
    const { GET } = await import("../route");
    mockGetChatById.mockResolvedValue(null as never);

    const response = await GET(request, paramsFor());
    const body = await response.json();

    expect(response.status).toBe(404);
    expect(body).toMatchObject({
      code: "not_found:chat",
    });
  });
});
