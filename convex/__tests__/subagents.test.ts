import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  internalMutation: jest.fn((config: unknown) => config),
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
    id: jest.fn(() => "id"),
    any: jest.fn(() => "any"),
    null: jest.fn(() => "null"),
  },
  ConvexError: class ConvexError extends Error {},
}));

const validateServiceKey = jest.fn();
jest.mock("../lib/utils", () => ({
  validateServiceKey: (...args: unknown[]) => validateServiceKey(...args),
}));

const {
  attachTriggerRunForBackend,
  cancelForBackend,
  cancelForChatDeletionBackend,
  failUnattachedForBackend,
  finishForBackend,
  listForParentMessage,
  reconcileAttachedRun,
  reconcileQueuedReservation,
  reserveForBackend,
  setMessageFeedback,
} = require("../subagents") as typeof import("../subagents");

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
  const runAfter = jest.fn<any>().mockResolvedValue(undefined);
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
  return {
    ctx: { db: { query, insert }, scheduler: { runAfter } } as any,
    insert,
    runAfter,
  };
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
    expect(validateServiceKey).toHaveBeenCalledWith("service-key");
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
    const { ctx, insert, runAfter } = makeCtx({});
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
    expect(runAfter).toHaveBeenCalledWith(5 * 60 * 1_000, expect.anything(), {
      subagentId: "sa_new",
      expectedCreatedAt: expect.any(Number),
    });
  });
});

describe("subagent presentation", () => {
  it("projects generic task fields for the sidebar", async () => {
    const row = {
      subagent_id: "sa_1",
      parent_trigger_run_id: "parent-run",
      parent_message_id: "parent-message",
      parent_tool_call_id: "tool-1",
      profile: "security_validation" as const,
      status: "running" as const,
      objective: "Inspect profile rendering for script injection.",
      candidate: args.candidate,
      created_at: 1,
      updated_at: 2,
    };
    const ctx = {
      auth: {
        getUserIdentity: jest
          .fn<any>()
          .mockResolvedValue({ subject: "user-1" }),
      },
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              order: jest.fn(() => ({
                take: jest.fn<any>().mockResolvedValue([row]),
              })),
            };
          }),
        })),
      },
    } as any;

    await expect(
      listForParentMessage.handler(ctx, { parentMessageId: "parent-message" }),
    ).resolves.toEqual([
      expect.objectContaining({
        profile: "security_validation",
        objective: "Inspect profile rendering for script injection.",
        title: "Stored XSS",
        subtitle: "https://example.test/profile",
      }),
    ]);
  });
});

describe("subagent message feedback", () => {
  it("persists feedback for an owned subagent response", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({
          subject: "user-1",
        }),
      },
      db: {
        get: jest.fn<any>().mockResolvedValue({
          _id: "subagent-message-1",
          user_id: "user-1",
          role: "assistant",
        }),
        patch,
      },
    } as any;

    await expect(
      setMessageFeedback.handler(ctx, {
        messageId: "subagent-message-1" as any,
        feedbackType: "negative",
        feedbackDetails: "Needs stronger reproduction evidence.",
      }),
    ).resolves.toBe("updated");
    expect(patch).toHaveBeenCalledWith(
      "subagent-message-1",
      expect.objectContaining({
        feedback_type: "negative",
        feedback_details: "Needs stronger reproduction evidence.",
        updated_at: expect.any(Number),
      }),
    );
  });

  it("rejects feedback for another user's subagent response", async () => {
    const ctx = {
      auth: {
        getUserIdentity: jest.fn<any>().mockResolvedValue({
          subject: "user-2",
        }),
      },
      db: {
        get: jest.fn<any>().mockResolvedValue({
          _id: "subagent-message-1",
          user_id: "user-1",
          role: "assistant",
        }),
        patch: jest.fn<any>(),
      },
    } as any;

    await expect(
      setMessageFeedback.handler(ctx, {
        messageId: "subagent-message-1" as any,
        feedbackType: "positive",
      }),
    ).rejects.toBeInstanceOf(Error);
    expect(ctx.db.patch).not.toHaveBeenCalled();
  });
});

describe("subagent finalization", () => {
  it("cancels a queued child without requiring a Trigger run id", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                user_id: "user-1",
                status: "queued",
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      cancelForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        userId: "user-1",
        triggerRunId: undefined,
        reason: "user_canceled_child",
      }),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: "user_canceled_child",
      }),
    );
  });

  it("attaches the Trigger id without reviving a terminal child", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                status: "canceled",
                completed_at: 1234,
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      attachTriggerRunForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        triggerRunId: "child-run",
      }),
    ).resolves.toBe("terminal");
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        trigger_run_id: "child-run",
        status: "canceled",
        started_at: undefined,
      }),
    );
  });

  it("persists partial usage after cancellation without losing its reason", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const row = {
      _id: "subagent-doc",
      status: "canceled",
      trigger_run_id: "child-run",
      summary: "Independent validation was canceled.",
      failure_code: "user_canceled_child",
      cancel_reason: "user_canceled_child",
      failure_reason: "Canceled from the sidebar",
      verdict: "inconclusive",
      confidence: "low",
      structured_result: { verdict: "inconclusive" },
      completed_at: 1234,
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
        failure_reason: "Canceled from the sidebar",
        verdict: "inconclusive",
        confidence: "low",
        structured_result: { verdict: "inconclusive" },
        completed_at: 1234,
        cost_dollars: 0.12,
        step_count: 3,
      }),
    );
    expect(validateServiceKey).toHaveBeenCalledWith("service-key");
  });

  it("fails a queued reservation that never attaches", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                subagent_id: "sa_1",
                status: "queued",
                created_at: 1234,
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      reconcileQueuedReservation.handler(ctx, {
        subagentId: "sa_1",
        expectedCreatedAt: 1234,
      }),
    ).resolves.toBeNull();
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        status: "failed",
        failure_code: "queue_timeout",
      }),
    );
  });

  it("records a parent wait failure only while the child is unattached", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                parent_trigger_run_id: "parent-run",
                status: "queued",
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      failUnattachedForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        parentTriggerRunId: "parent-run",
        failureCode: "child_wait_failed",
        summary: "Subagent stopped before returning a result.",
      }),
    ).resolves.toBe(true);
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        status: "failed",
        failure_code: "child_wait_failed",
      }),
    );
  });

  it("times out an attached child that never records a terminal result", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                status: "finalizing",
                trigger_run_id: "child-run",
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      reconcileAttachedRun.handler(ctx, {
        subagentId: "sa_1",
        triggerRunId: "child-run",
      }),
    ).resolves.toBeNull();
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        status: "timed_out",
        failure_code: "runtime_watchdog_timeout",
      }),
    );
  });

  it("leaves an already completed child unchanged when its watchdog fires", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            return {
              first: jest.fn<any>().mockResolvedValue({
                _id: "subagent-doc",
                status: "completed",
                trigger_run_id: "child-run",
              }),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      reconcileAttachedRun.handler(ctx, {
        subagentId: "sa_1",
        triggerRunId: "child-run",
      }),
    ).resolves.toBeNull();
    expect(patch).not.toHaveBeenCalled();
  });
});

describe("subagent deletion cancellation", () => {
  it("returns active and retryable canceled Trigger ids before chat deletion", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const rowsByStatus: Record<string, Array<Record<string, unknown>>> = {
      running: [
        {
          _id: "active-child",
          user_id: "user-1",
          status: "running",
          trigger_run_id: "child-run-active",
        },
      ],
      canceled: [
        {
          _id: "retry-child",
          user_id: "user-1",
          status: "canceled",
          trigger_run_id: "child-run-retry",
          cancel_reason: "chat_deleted",
        },
      ],
    };
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            let status = "";
            const q = {
              eq: jest.fn((field: string, value: string) => {
                if (field === "status") status = value;
                return q;
              }),
            };
            callback(q);
            return {
              take: jest
                .fn<any>()
                .mockResolvedValue(rowsByStatus[status] ?? []),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      cancelForChatDeletionBackend.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        userId: "user-1",
        reason: "chat_deleted",
      }),
    ).resolves.toEqual({
      triggerRunIds: ["child-run-active", "child-run-retry"],
      hasMore: false,
    });
    expect(patch).toHaveBeenCalledTimes(1);
    expect(patch).toHaveBeenCalledWith(
      "active-child",
      expect.objectContaining({
        status: "canceled",
        cancel_reason: "chat_deleted",
      }),
    );
  });

  it("fails closed without patching when a status batch is truncated", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const runningRows = Array.from({ length: 101 }, (_, index) => ({
      _id: `active-child-${index}`,
      user_id: "user-1",
      status: "running",
      trigger_run_id: `child-run-${index}`,
    }));
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            let status = "";
            const q = {
              eq: jest.fn((field: string, value: string) => {
                if (field === "status") status = value;
                return q;
              }),
            };
            callback(q);
            return {
              take: jest
                .fn<any>()
                .mockResolvedValue(status === "running" ? runningRows : []),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      cancelForChatDeletionBackend.handler(ctx, {
        serviceKey: "service-key",
        chatId: "chat-1",
        userId: "user-1",
        reason: "chat_deleted",
      }),
    ).resolves.toEqual({ triggerRunIds: [], hasMore: true });
    expect(patch).not.toHaveBeenCalled();
  });
});
