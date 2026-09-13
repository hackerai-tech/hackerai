import { beforeEach, describe, expect, it, jest } from "@jest/globals";

import {
  SUBAGENT_MAX_DURATION_SECONDS,
  SUBAGENT_WATCHDOG_GRACE_SECONDS,
} from "../../lib/ai/subagents/contracts";

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
  cancelForUserDeletionBackend,
  claimNextTerminalForParentBackend,
  consumePendingMessagesForBackend,
  failUnattachedForBackend,
  finishForBackend,
  listForParentMessage,
  markResultConsumedForParentBackend,
  markResultInjectedForParentBackend,
  reconcileAttachedRun,
  reconcileQueuedReservation,
  reserveForBackend,
  resumeForBackend,
  sendMessageForBackend,
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
  deletionFenced = false,
  chat = {
    id: "chat-1",
    user_id: "user-1",
  },
}: {
  exact?: Record<string, any> | null;
  parentRuns?: Array<Record<string, any>>;
  sameCandidate?: Array<Record<string, any>>;
  deletionFenced?: boolean;
  chat?: Record<string, any> | null;
}) => {
  const insert = jest.fn<any>().mockResolvedValue("subagent-doc");
  const patch = jest.fn<any>().mockResolvedValue(undefined);
  const runAfter = jest.fn<any>().mockResolvedValue(undefined);
  const chain = {
    eq: jest.fn<any>(),
  };
  chain.eq.mockReturnValue(chain);
  const query = jest.fn((table: string) => ({
    withIndex: jest.fn((indexName: string, callback: (q: any) => unknown) => {
      callback(chain);
      if (table === "user_deletion_fences") {
        return {
          first: jest
            .fn<any>()
            .mockResolvedValue(deletionFenced ? { _id: "fence-1" } : null),
        };
      }
      if (table === "chats") {
        return {
          first: jest.fn<any>().mockResolvedValue(chat),
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
    ctx: { db: { query, insert, patch }, scheduler: { runAfter } } as any,
    insert,
    patch,
    runAfter,
  };
};

describe("subagent continuation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("only resumes successfully completed general children", async () => {
    const { ctx, patch } = makeCtx({
      parentRuns: [
        {
          _id: "run-1",
          subagent_id: "sa_failed",
          profile: "general",
          status: "failed",
        },
      ],
    });

    await expect(
      resumeForBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        targetAgentId: "sa_failed",
        followUp: "Check one more thing",
      }),
    ).resolves.toEqual({ outcome: "not_resumable" });
    expect(patch).not.toHaveBeenCalled();
  });

  it("requeues a completed general child with a bounded continuation", async () => {
    const { ctx, patch, runAfter } = makeCtx({
      parentRuns: [
        {
          _id: "run-1",
          subagent_id: "sa_completed",
          profile: "general",
          status: "completed",
          created_at: 123,
          cost_dollars: 0.5,
        },
      ],
    });

    await expect(
      resumeForBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        targetAgentId: "sa_completed",
        followUp: "Check one more thing",
      }),
    ).resolves.toEqual({ outcome: "resumed", subagentId: "sa_completed" });
    expect(patch).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "queued",
        continuation_count: 1,
        continuation_prompt: "Check one more thing",
      }),
    );
    expect(runAfter).toHaveBeenCalled();
  });

  it("does not resume a child after account deletion starts", async () => {
    const { ctx, patch, runAfter } = makeCtx({
      deletionFenced: true,
      parentRuns: [
        {
          _id: "run-1",
          subagent_id: "sa_completed",
          profile: "general",
          status: "completed",
          created_at: 123,
        },
      ],
    });

    await expect(
      resumeForBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        targetAgentId: "sa_completed",
        followUp: "Continue after deletion",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(patch).not.toHaveBeenCalled();
    expect(runAfter).not.toHaveBeenCalled();
  });

  it("does not resume a child after chat deletion starts", async () => {
    const { ctx, patch, runAfter } = makeCtx({
      chat: {
        id: "chat-1",
        user_id: "user-1",
        deletion_started_at: 123,
      },
      parentRuns: [
        {
          _id: "run-1",
          subagent_id: "sa_completed",
          profile: "general",
          status: "completed",
          created_at: 123,
        },
      ],
    });

    await expect(
      resumeForBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        targetAgentId: "sa_completed",
        followUp: "Continue after deletion",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(patch).not.toHaveBeenCalled();
    expect(runAfter).not.toHaveBeenCalled();
  });
});

describe("subagent reservation", () => {
  beforeEach(() => jest.clearAllMocks());

  it("does not reserve a child after account deletion starts", async () => {
    const { ctx, insert } = makeCtx({ deletionFenced: true });

    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "chat_missing",
    });
    expect(insert).not.toHaveBeenCalled();
  });

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

  it("allows two active siblings and blocks the third transactionally", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [{ status: "running" }, { status: "queued" }],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "active_limit",
    });
    expect(insert).not.toHaveBeenCalled();
  });

  it("caps a parent run at four total children", async () => {
    const { ctx, insert } = makeCtx({
      parentRuns: [
        { status: "completed" },
        { status: "failed" },
        { status: "canceled" },
        { status: "timed_out" },
      ],
    });
    await expect(reserveForBackend.handler(ctx, args)).resolves.toEqual({
      outcome: "total_limit",
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
      skills: ["vulnerabilities/idor", "analysis/source_aware_discovery"],
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
        skills: ["vulnerabilities/idor", "analysis/source_aware_discovery"],
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

describe("subagent coordination messages", () => {
  const makeSendContext = (runs: Array<Record<string, any>>) => {
    const insert = jest.fn<any>().mockResolvedValue("message-doc");
    const ctx = {
      db: {
        query: jest.fn((table: string) => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const predicates: Array<[string, unknown]> = [];
            const q = {
              eq: jest.fn<any>((field: string, value: unknown) => {
                predicates.push([field, value]);
                return q;
              }),
            };
            callback(q);
            return table === "subagent_runs"
              ? {
                  take: jest
                    .fn<any>()
                    .mockResolvedValue(
                      runs.filter((run) =>
                        predicates.every(
                          ([field, value]) => run[field] === value,
                        ),
                      ),
                    ),
                }
              : { first: jest.fn<any>().mockResolvedValue(null) };
          }),
        })),
        insert,
      },
    } as any;
    return { ctx, insert };
  };

  it("delivers a named update only to an active child owned by the same chat", async () => {
    const run = {
      _id: "subagent-doc",
      subagent_id: "sa_1",
      user_id: "user-1",
      chat_id: "chat-1",
      parent_trigger_run_id: "parent-run",
      parent_message_id: "parent-message",
      name: "Stored XSS validator",
      status: "running",
    };
    const { ctx, insert } = makeSendContext([run]);

    await expect(
      sendMessageForBackend.handler(ctx, {
        serviceKey: "service-key",
        targetAgentId: "sa_1",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        parentToolCallId: "tool-send-1",
        messageId: "msg_123",
        message: "Use the newly captured response.",
        messageType: "information",
        priority: "high",
      }),
    ).resolves.toEqual({
      outcome: "delivered",
      subagentId: "sa_1",
      messageId: "msg_123",
      agentName: "Stored XSS validator",
      status: "running",
      parentMessageId: "parent-message",
    });
    expect(insert).toHaveBeenCalledWith(
      "subagent_messages",
      expect.objectContaining({
        subagent_id: "sa_1",
        message_source: "parent_update",
        delivery_status: "pending",
        message_type: "information",
        priority: "high",
      }),
    );
  });

  it("resolves a short handle within the authenticated parent run", async () => {
    const fullId = "sa_09041c08070448b5a5cee3c7c5454b66";
    const { ctx, insert } = makeSendContext([
      {
        subagent_id: fullId,
        user_id: "user-1",
        chat_id: "chat-1",
        parent_trigger_run_id: "parent-run",
        parent_message_id: "parent-message",
        name: "Permission validator",
        status: "running",
      },
      {
        subagent_id: "sa_09041c08aaaaaaaaaaaaaaaaaaaaaaaa",
        user_id: "user-2",
        chat_id: "chat-1",
        parent_trigger_run_id: "parent-run",
        status: "running",
      },
      {
        subagent_id: "sa_09041c08bbbbbbbbbbbbbbbbbbbbbbbb",
        user_id: "user-1",
        chat_id: "chat-1",
        parent_trigger_run_id: "other-parent-run",
        status: "running",
      },
      {
        subagent_id: "sa_09041c08cccccccccccccccccccccccc",
        user_id: "user-1",
        chat_id: "other-chat",
        parent_trigger_run_id: "parent-run",
        status: "running",
      },
    ]);

    await expect(
      sendMessageForBackend.handler(ctx, {
        serviceKey: "service-key",
        targetAgentId: "sa_09041c08",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        parentToolCallId: "tool-send-1",
        messageId: "msg_short",
        message: "Use the exact synthetic marker.",
        messageType: "information",
        priority: "normal",
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        outcome: "delivered",
        subagentId: fullId,
        agentName: "Permission validator",
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      "subagent_messages",
      expect.objectContaining({ subagent_id: fullId }),
    );
  });

  it("fails closed when a parent-scoped short handle is ambiguous", async () => {
    const { ctx, insert } = makeSendContext([
      {
        subagent_id: "sa_09041c08000000000000000000000000",
        user_id: "user-1",
        chat_id: "chat-1",
        parent_trigger_run_id: "parent-run",
        status: "running",
      },
      {
        subagent_id: "sa_09041c08ffffffffffffffffffffffff",
        user_id: "user-1",
        chat_id: "chat-1",
        parent_trigger_run_id: "parent-run",
        status: "running",
      },
    ]);

    await expect(
      sendMessageForBackend.handler(ctx, {
        serviceKey: "service-key",
        targetAgentId: "sa_09041c08",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        parentToolCallId: "tool-send-1",
        messageId: "msg_ambiguous",
        message: "Update",
        messageType: "information",
        priority: "normal",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not reveal or update another user's child", async () => {
    const { ctx, insert } = makeSendContext([
      {
        subagent_id: "sa_1",
        user_id: "user-2",
        chat_id: "chat-1",
        parent_trigger_run_id: "parent-run",
        status: "running",
      },
    ]);

    await expect(
      sendMessageForBackend.handler(ctx, {
        serviceKey: "service-key",
        targetAgentId: "sa_1",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        parentToolCallId: "tool-send-1",
        messageId: "msg_123",
        message: "Update",
        messageType: "information",
        priority: "normal",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("does not steer a child created by another parent run in the same chat", async () => {
    const { ctx, insert } = makeSendContext([
      {
        subagent_id: "sa_1",
        user_id: "user-1",
        chat_id: "chat-1",
        parent_trigger_run_id: "other-parent-run",
        status: "running",
      },
    ]);

    await expect(
      sendMessageForBackend.handler(ctx, {
        serviceKey: "service-key",
        targetAgentId: "sa_1",
        userId: "user-1",
        chatId: "chat-1",
        parentTriggerRunId: "parent-run",
        parentToolCallId: "tool-send-1",
        messageId: "msg_123",
        message: "Update",
        messageType: "information",
        priority: "normal",
      }),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("consumes queued parent updates once the owned child is running", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const ctx = {
      db: {
        query: jest.fn((table: string) => ({
          withIndex: jest.fn((_name: string, callback: (q: any) => void) => {
            const q = { eq: jest.fn<any>() };
            q.eq.mockReturnValue(q);
            callback(q);
            if (table === "subagent_runs") {
              return {
                first: jest.fn<any>().mockResolvedValue({
                  trigger_run_id: "child-run",
                  status: "running",
                }),
              };
            }
            return {
              order: jest.fn(() => ({
                take: jest.fn<any>().mockResolvedValue([
                  {
                    _id: "message-doc",
                    external_message_id: "msg_123",
                    parts: [{ type: "text", text: "Use new evidence" }],
                    message_type: "instruction",
                    priority: "high",
                  },
                ]),
              })),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      consumePendingMessagesForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        triggerRunId: "child-run",
      }),
    ).resolves.toEqual([
      {
        messageId: "msg_123",
        content: "Use new evidence",
        messageType: "instruction",
        priority: "high",
      },
    ]);
    expect(patch).toHaveBeenCalledWith(
      "message-doc",
      expect.objectContaining({ delivery_status: "consumed" }),
    );
  });

  it("claims an untargeted completion once and targeted completion idempotently", async () => {
    const row: Record<string, any> = {
      _id: "subagent-doc",
      subagent_id: "sa_1",
      user_id: "user-1",
      chat_id: "chat-1",
      parent_trigger_run_id: "parent-run",
      parent_message_id: "parent-message",
      name: "Stored XSS validator",
      profile: "security_validation",
      status: "completed",
      objective: "Validate XSS",
      context_refs: [],
      candidate_fingerprint: "fingerprint",
      depth: 1,
      subscription: "pro",
      cost_limit_dollars: 1,
      created_at: 1,
      updated_at: 2,
    };
    const patch = jest
      .fn<any>()
      .mockImplementation(
        async (_id: string, value: Record<string, unknown>) => {
          Object.assign(row, value);
        },
      );
    const withIndex = jest.fn((_name: string, callback: (q: any) => void) => {
      const q = { eq: jest.fn<any>() };
      q.eq.mockReturnValue(q);
      callback(q);
      expect(q.eq.mock.calls).toEqual([
        ["user_id", "user-1"],
        ["chat_id", "chat-1"],
        ["parent_trigger_run_id", "parent-run"],
      ]);
      return {
        order: jest.fn(() => ({
          take: jest.fn<any>().mockResolvedValue([row]),
        })),
      };
    });
    const ctx = {
      db: {
        query: jest.fn(() => ({
          withIndex,
        })),
        patch,
      },
    } as any;
    const claimArgs = {
      serviceKey: "service-key",
      userId: "user-1",
      chatId: "chat-1",
      parentTriggerRunId: "parent-run",
      deliveryClaimId: "claim-1",
    };

    await expect(
      claimNextTerminalForParentBackend.handler(ctx, {
        ...claimArgs,
        targetAgentIds: ["sa_1", "sa_unknown"],
      }),
    ).resolves.toEqual({
      terminal: null,
      active: [],
      unmatchedTargetAgentIds: ["sa_unknown"],
      pendingDeliveryCount: 1,
    });
    expect(patch).not.toHaveBeenCalled();

    await expect(
      claimNextTerminalForParentBackend.handler(ctx, claimArgs),
    ).resolves.toEqual({
      terminal: expect.objectContaining({ name: "Stored XSS validator" }),
      active: [],
      unmatchedTargetAgentIds: [],
      pendingDeliveryCount: 1,
      deliveryClaimId: "claim-1",
    });
    await expect(
      claimNextTerminalForParentBackend.handler(ctx, {
        ...claimArgs,
        deliveryClaimId: "claim-2",
      }),
    ).resolves.toEqual({
      terminal: null,
      active: [],
      unmatchedTargetAgentIds: [],
      pendingDeliveryCount: 1,
      deliveryClaimId: undefined,
    });
    await expect(
      claimNextTerminalForParentBackend.handler(ctx, claimArgs),
    ).resolves.toEqual({
      terminal: expect.objectContaining({ name: "Stored XSS validator" }),
      active: [],
      unmatchedTargetAgentIds: [],
      pendingDeliveryCount: 1,
      deliveryClaimId: "claim-1",
    });
    await expect(
      claimNextTerminalForParentBackend.handler(ctx, {
        ...claimArgs,
        targetAgentIds: ["sa_1"],
      }),
    ).resolves.toEqual({
      terminal: expect.objectContaining({ name: "Stored XSS validator" }),
      active: [],
      unmatchedTargetAgentIds: [],
      pendingDeliveryCount: 1,
      deliveryClaimId: "claim-1",
    });
    await expect(
      claimNextTerminalForParentBackend.handler(ctx, {
        ...claimArgs,
        targetAgentIds: ["sa_unknown"],
      }),
    ).resolves.toEqual({
      terminal: null,
      active: [],
      unmatchedTargetAgentIds: ["sa_unknown"],
      pendingDeliveryCount: 0,
    });
    expect(patch).toHaveBeenCalledTimes(3);
    expect(withIndex).toHaveBeenCalledWith(
      "by_user_chat_and_parent_run",
      expect.any(Function),
    );
  });

  it("acknowledges injection before marking a claimed result consumed", async () => {
    const row: Record<string, any> = {
      _id: "subagent-doc",
      subagent_id: "sa_1",
      user_id: "user-1",
      chat_id: "chat-1",
      parent_trigger_run_id: "parent-run",
      parent_delivery_claim_id: "claim-1",
    };
    const patch = jest
      .fn<any>()
      .mockImplementation(
        async (_id: string, value: Record<string, unknown>) => {
          Object.assign(row, value);
        },
      );
    const unique = jest.fn<any>().mockResolvedValue(row);
    const withIndex = jest.fn((_name: string, callback: (q: any) => void) => {
      const q = { eq: jest.fn<any>() };
      q.eq.mockReturnValue(q);
      callback(q);
      return { unique };
    });
    const ctx = {
      db: { query: jest.fn(() => ({ withIndex })), patch },
    } as any;
    const deliveryArgs = {
      serviceKey: "service-key",
      userId: "user-1",
      chatId: "chat-1",
      parentTriggerRunId: "parent-run",
      subagentId: "sa_1",
      deliveryClaimId: "claim-1",
    };

    await expect(
      markResultInjectedForParentBackend.handler(ctx, {
        ...deliveryArgs,
        userId: "different-user",
      }),
    ).resolves.toBe("not_found");
    expect(patch).not.toHaveBeenCalled();

    await expect(
      markResultInjectedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("updated");
    expect(row.parent_result_injected_at).toEqual(expect.any(Number));
    expect(row.parent_result_consumed_at).toBeUndefined();

    await expect(
      markResultConsumedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("updated");
    expect(row.parent_result_consumed_at).toEqual(expect.any(Number));
    expect(row.parent_notified_at).toEqual(row.parent_result_consumed_at);

    await expect(
      markResultConsumedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("already_consumed");

    delete row.parent_result_consumed_at;
    delete row.parent_notified_at;
    row.parent_delivery_claim_id = "different-claim";
    await expect(
      markResultConsumedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("stale_claim");
    expect(row.parent_result_consumed_at).toBeUndefined();

    row.parent_delivery_claim_id = "claim-1";
    delete row.parent_result_injected_at;
    await expect(
      markResultConsumedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("stale_claim");
    expect(row.parent_result_consumed_at).toBeUndefined();

    unique.mockResolvedValueOnce(null);
    await expect(
      markResultConsumedForParentBackend.handler(ctx, deliveryArgs),
    ).resolves.toBe("not_found");
    expect(row.parent_result_consumed_at).toBeUndefined();
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

  it("schedules a bounded watchdog when attaching an active child", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const runAfter = jest.fn<any>().mockResolvedValue(undefined);
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
                status: "queued",
              }),
            };
          }),
        })),
        patch,
      },
      scheduler: { runAfter },
    } as any;

    await expect(
      attachTriggerRunForBackend.handler(ctx, {
        serviceKey: "service-key",
        subagentId: "sa_1",
        triggerRunId: "child-run",
      }),
    ).resolves.toBe("updated");
    expect(patch).toHaveBeenCalledWith(
      "subagent-doc",
      expect.objectContaining({
        trigger_run_id: "child-run",
        status: "running",
        started_at: expect.any(Number),
      }),
    );
    expect(runAfter).toHaveBeenCalledWith(
      (SUBAGENT_MAX_DURATION_SECONDS + SUBAGENT_WATCHDOG_GRACE_SECONDS) * 1_000,
      expect.anything(),
      { subagentId: "sa_1", triggerRunId: "child-run" },
    );
  });

  it("persists partial usage after cancellation without losing its reason", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const row = {
      _id: "subagent-doc",
      status: "canceled",
      trigger_run_id: "child-run",
      summary: "Subagent was canceled.",
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
        summary: "Subagent was canceled.",
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

  it("retries a sandbox-deletion cancellation after Trigger cleanup fails", async () => {
    const patch = jest.fn<any>().mockResolvedValue(undefined);
    const retryRow = {
      _id: "retry-child",
      user_id: "user-1",
      status: "canceled",
      trigger_run_id: "child-run-retry",
      cancel_reason: "terminal-sandbox-deleted",
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
                .mockResolvedValue(status === "canceled" ? [retryRow] : []),
            };
          }),
        })),
        patch,
      },
    } as any;

    await expect(
      cancelForUserDeletionBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "user-1",
        reason: "terminal-sandbox-deleted",
      }),
    ).resolves.toEqual({
      triggerRunIds: ["child-run-retry"],
      hasMore: false,
    });
    expect(patch).not.toHaveBeenCalled();
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
