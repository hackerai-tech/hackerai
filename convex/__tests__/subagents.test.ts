import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: unknown) => config),
  query: jest.fn((config: unknown) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    array: jest.fn(() => "array"),
    literal: jest.fn(() => "literal"),
    any: jest.fn(() => "any"),
    null: jest.fn(() => "null"),
  },
  ConvexError: class ConvexError extends Error {},
}));

const validateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => validateServiceKey(...args),
}));

const { finishForBackend, reserveForBackend } =
  require("../subagents") as typeof import("../subagents");

const args = {
  serviceKey: "service-key",
  subagentId: "sa_new",
  userId: "user-1",
  chatId: "chat-1",
  parentMessageId: "parent-run",
  parentToolCallId: "tool-1",
  parentTriggerRunId: "parent-run",
  objective: "Validate independently",
  candidate: {
    title: "Stored XSS",
    affected_asset: "https://example.test/profile",
    weakness_class: "CWE-79",
    claimed_impact: "Session compromise",
  },
  candidateFingerprint: "fingerprint",
  contextRefs: [],
  permissionMode: "full_access",
  selectedModel: "agent-model",
  subscription: "pro" as const,
};

const makeCtx = ({
  exact = null,
  parentRuns = [],
  sameCandidate = [],
}: {
  exact?: Record<string, any> | null;
  parentRuns?: Array<Record<string, any>>;
  sameCandidate?: Array<Record<string, any>>;
}) => {
  const insert = jest.fn<any>().mockResolvedValue("subagent-doc");
  const chain = {
    eq: jest.fn<any>(),
  };
  chain.eq.mockReturnValue(chain);
  const query = jest.fn((table: string) => ({
    withIndex: jest.fn((indexName: string, callback: (q: any) => unknown) => {
      callback(chain);
      if (table === "chats") {
        return {
          first: jest.fn<any>().mockResolvedValue({
            id: "chat-1",
            user_id: "user-1",
          }),
        };
      }
      if (indexName === "by_parent_run_and_tool_call") {
        return { first: jest.fn<any>().mockResolvedValue(exact) };
      }
      if (indexName === "by_user_chat_and_parent_run") {
        return { take: jest.fn<any>().mockResolvedValue(parentRuns) };
      }
      return {
        order: jest.fn(() => ({
          take: jest.fn<any>().mockResolvedValue(sameCandidate),
        })),
      };
    }),
  }));
  return { ctx: { db: { query, insert } } as any, insert };
};

describe("subagent reservation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns the exact prior child for a retried parent tool call", async () => {
    const { ctx, insert } = makeCtx({
      exact: {
        subagent_id: "sa_existing",
        status: "running",
        trigger_run_id: "child-run",
      },
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "existing",
      subagentId: "sa_existing",
      status: "running",
      triggerRunId: "child-run",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("enforces one active child per parent run transactionally", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [{ status: "running" }],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "active_limit",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("reuses an active validation of the same candidate before applying limits", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [{ status: "running" }],
      sameCandidate: [
        {
          subagent_id: "sa_candidate",
          parent_trigger_run_id: "parent-run",
          status: "running",
          trigger_run_id: "child-run",
        },
      ],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "existing",
      subagentId: "sa_candidate",
      status: "running",
      triggerRunId: "child-run",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("enforces the aggregate parent spend limit", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [
        { status: "failed", cost_dollars: 1.6 },
        { status: "failed", cost_dollars: 1.4 },
      ],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "spend_limit",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("shrinks the next child cap to the remaining parent budget", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [
        { status: "failed", cost_dollars: 1.2 },
        { status: "failed", cost_dollars: 1.2 },
      ],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "created",
      subagentId: "sa_new",
      status: "queued",
    });
    expect(insert).toHaveBeenCalledWith(
      "subagent_runs",
      expect.objectContaining({ cost_limit_dollars: expect.any(Number) }),
    );
    expect(insert.mock.calls[0]?.[1].cost_limit_dollars).toBeCloseTo(0.6);
  });

  it("creates a depth-one queued validation child", async () => {
    const { ctx, insert } = makeCtx({});
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "created",
      subagentId: "sa_new",
      status: "queued",
    });
    expect(insert).toHaveBeenCalledWith(
      "subagent_runs",
      expect.objectContaining({
        subagent_id: "sa_new",
        depth: 1,
        profile: "security_validation",
        status: "queued",
        cost_limit_dollars: 1,
      }),
    );
  });
});

describe("subagent finalization", () => {
  it("persists partial usage after cancellation without losing its reason", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const row = {
      _id: "subagent-doc",
      status: "canceled",
      trigger_run_id: "child-run",
      summary: "Independent validation was canceled.",
      failure_code: "user_canceled_child",
      cancel_reason: "user_canceled_child",
    };
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return { first: jest.fn<any>().mockResolvedValue(row) };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      finishForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        triggerRunId: "child-run",
        status: "canceled",
        summary: "Runtime canceled.",
        failureCode: "parent_or_user_canceled",
        cancelReason: "parent_or_user_canceled",
        costDollars: 0.12,
        stepCount: 3,
      }),
    ).resolves.toBe("updated");

    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        summary: "Independent validation was canceled.",
        failure_code: "user_canceled_child",
        cancel_reason: "user_canceled_child",
        cost_dollars: 0.12,
        step_count: 3,
      }),
    );
  });
});
