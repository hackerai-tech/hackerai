import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
  internalQuery: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => {
  const actual =
    jest.requireActual<typeof import("convex/values")>("convex/values");
  return {
    ...actual,
    v: new Proxy({}, { get: () => jest.fn(() => "validator") }),
  };
});

jest.mock("convex/server", () => ({
  paginationOptsValidator: "paginationOptsValidator",
}));

jest.mock("../_generated/api", () => ({
  internal: {
    messages: {},
    s3Cleanup: {},
  },
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
  copyChatSummary: jest.fn(),
}));

jest.mock("../lib/suspensionGuards", () => ({
  CHAT_ACCESS_SUSPENDED_CODE: "CHAT_ACCESS_SUSPENDED",
  assertUserCanAccessChatHistory: jest.fn<any>().mockResolvedValue(undefined),
  isUserBlockedByActiveFraudDispute: jest.fn<any>().mockResolvedValue(false),
}));

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: {
    deleteIfExists: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

jest.mock("../lib/logger", () => ({
  convexLogger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const CHAT_ID = "11111111-1111-4111-8111-111111111111";
const SHARE_ID = "22222222-2222-4222-8222-222222222222";

const privateFindingPart = {
  type: "tool-create_vulnerability_report",
  toolCallId: "tool-secret",
  state: "output-available",
  input: {
    title: "Confirmed IDOR",
    target: "app.example.test",
    evidence: "private evidence",
    technical_analysis: "private analysis",
    poc_script_code: "private exploit",
    cve: "CVE-2026-12345",
    cwe: "CWE-639",
    code_locations: [{ file: "private.ts" }],
  },
  output: {
    success: true,
    finding_id: "finding-secret",
    title: "Confirmed IDOR",
    target: "app.example.test",
    severity: "high",
    cvss_score: 7.1,
  },
};

const safeFindingPart = {
  type: "data-shared-finding",
  data: {
    title: "Confirmed IDOR",
    target: "app.example.test",
    severity: "high",
    cvss_score: 7.1,
  },
};

const sourceChat = {
  _id: "chat-doc-1",
  id: CHAT_ID,
  title: "Invoice test",
  user_id: "owner-user",
  share_id: SHARE_ID,
  share_date: 2_000,
};

const sourceMessage = {
  _id: "message-doc-1",
  _creationTime: 1_000,
  id: "message-1",
  chat_id: CHAT_ID,
  user_id: "owner-user",
  role: "assistant" as const,
  parts: [privateFindingPart],
  update_time: 1_000,
};

function createSharedCtx({ authenticated = false } = {}) {
  const insert = jest.fn<any>().mockResolvedValue("inserted-doc");
  const query = jest.fn((table: string) => ({
    withIndex: jest.fn(() => {
      if (table === "chats") {
        return { first: jest.fn<any>().mockResolvedValue(sourceChat) };
      }
      if (table === "messages") {
        return {
          order: jest.fn(() => ({
            collect: jest.fn<any>().mockResolvedValue([sourceMessage]),
          })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    }),
  }));

  return {
    ctx: {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue(authenticated ? { subject: "fork-user" } : null),
      },
      db: { query, insert },
    } as any,
    insert,
  };
}

const expectNoPrivateFindingData = (value: unknown) => {
  expect(JSON.stringify(value)).not.toMatch(
    /tool-secret|finding-secret|private evidence|private analysis|private exploit|private\.ts|CVE|CWE/,
  );
};

describe("shared finding security boundary", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns only safe compact finding metadata from public shared reads", async () => {
    const { getSharedMessages } = await import("../messages");
    const { ctx } = createSharedCtx();

    const result = await getSharedMessages.handler(ctx, { chatId: CHAT_ID });

    expect(result).toHaveLength(1);
    expect(result[0].parts).toEqual([safeFindingPart]);
    expectNoPrivateFindingData(result);
  });

  it("persists only safe compact finding metadata in shared-chat forks", async () => {
    const { forkSharedChat } = await import("../sharedChats");
    const { ctx, insert } = createSharedCtx({ authenticated: true });

    await forkSharedChat.handler(ctx, { shareId: SHARE_ID });

    const messageInsert = insert.mock.calls.find(
      ([table]: [string]) => table === "messages",
    );
    expect(messageInsert).toBeDefined();
    expect(messageInsert?.[1]).toEqual(
      expect.objectContaining({ parts: [safeFindingPart] }),
    );
    expectNoPrivateFindingData(messageInsert?.[1]);
  });
});
