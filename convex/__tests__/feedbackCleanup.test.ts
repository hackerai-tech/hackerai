import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    literal: jest.fn((value) => value),
    id: jest.fn(() => "id"),
    null: jest.fn(() => "null"),
  },
  ConvexError: class ConvexError extends Error {
    data: unknown;
    constructor(data: unknown) {
      super(
        typeof data === "string" ? data : (data as { message: string }).message,
      );
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));

jest.mock("../lib/logger", () => ({
  convexLogger: {
    warn: jest.fn(),
  },
}));

function buildQuery<T>(rows: T[]) {
  const lt = jest.fn<any>().mockReturnValue("lt");
  const eq = jest.fn<any>().mockReturnValue("eq");
  const query: any = {
    withIndex: jest.fn<any>((_name: string, builder: any) => {
      builder({ lt, eq });
      return query;
    }),
    order: jest.fn<any>().mockReturnThis(),
    take: jest.fn<any>().mockResolvedValue(rows),
    collect: jest.fn<any>().mockResolvedValue(rows),
    lt,
    eq,
  };
  return query;
}

describe("feedback cleanup", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("deletes old feedback and clears linked message pointers first", async () => {
    const cutoffTimeMs = Date.now() - 180 * 24 * 60 * 60 * 1000;
    const feedbackRows = [
      { _id: "feedback-1", _creationTime: cutoffTimeMs - 1_000 },
      { _id: "feedback-2", _creationTime: cutoffTimeMs - 500 },
    ];
    const messageRows = [{ _id: "message-1", feedback_id: "feedback-1" }];
    const feedbackQuery = buildQuery(feedbackRows);
    const firstMessagesQuery = buildQuery(messageRows);
    const secondMessagesQuery = buildQuery([]);

    const mockCtx: any = {
      db: {
        query: jest.fn<any>((table: string) => {
          if (table === "feedback") return feedbackQuery;
          if (table === "messages") {
            return mockCtx.db.query.mock.calls.filter(
              ([name]: [string]) => name === "messages",
            ).length === 1
              ? firstMessagesQuery
              : secondMessagesQuery;
          }
          throw new Error(`Unexpected table ${table}`);
        }),
        patch: jest.fn<any>(),
        delete: jest.fn<any>(),
      },
    };

    const { purgeOldFeedback } = (await import("../feedback")) as any;
    const result = await purgeOldFeedback.handler(mockCtx, {
      cutoffTimeMs,
      limit: 2,
    });

    expect(result).toEqual({ deletedCount: 2 });
    expect(feedbackQuery.withIndex).toHaveBeenCalledWith(
      "by_creation_time",
      expect.any(Function),
    );
    expect(feedbackQuery.lt).toHaveBeenCalledWith(
      "_creationTime",
      cutoffTimeMs,
    );
    expect(feedbackQuery.take).toHaveBeenCalledWith(2);
    expect(firstMessagesQuery.withIndex).toHaveBeenCalledWith(
      "by_feedback_id",
      expect.any(Function),
    );
    expect(firstMessagesQuery.eq).toHaveBeenCalledWith(
      "feedback_id",
      "feedback-1",
    );
    expect(mockCtx.db.patch).toHaveBeenCalledWith("message-1", {
      feedback_id: undefined,
    });
    expect(mockCtx.db.delete).toHaveBeenNthCalledWith(1, "feedback-1");
    expect(mockCtx.db.delete).toHaveBeenNthCalledWith(2, "feedback-2");
  });

  it("returns zero and does not delete when there are no expired rows", async () => {
    const feedbackQuery = buildQuery([]);
    const mockCtx: any = {
      db: {
        query: jest.fn<any>().mockReturnValue(feedbackQuery),
        patch: jest.fn<any>(),
        delete: jest.fn<any>(),
      },
    };

    const { purgeOldFeedback } = (await import("../feedback")) as any;
    const result = await purgeOldFeedback.handler(mockCtx, {
      cutoffTimeMs: Date.now(),
    });

    expect(result).toEqual({ deletedCount: 0 });
    expect(feedbackQuery.take).toHaveBeenCalledWith(100);
    expect(mockCtx.db.patch).not.toHaveBeenCalled();
    expect(mockCtx.db.delete).not.toHaveBeenCalled();
  });
});
