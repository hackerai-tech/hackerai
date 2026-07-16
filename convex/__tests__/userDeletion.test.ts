import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config) => config),
}));

jest.mock("convex/values", () => ({
  v: new Proxy(
    {},
    {
      get: () => jest.fn(() => "validator"),
    },
  ),
}));

jest.mock("../_generated/api", () => ({
  internal: {
    s3Cleanup: {
      deleteS3ObjectsBatchAction: "deleteS3ObjectsBatchAction",
    },
  },
}));

const mockFileCountAggregate = {
  deleteIfExists: jest.fn().mockResolvedValue(undefined),
};

jest.mock("../fileAggregate", () => ({
  fileCountAggregate: mockFileCountAggregate,
}));

type Row = { _id: string; [key: string]: any };
type Tables = Record<string, Row[]>;
type ReadCounter = { value: number };

function createQueryResult(rows: Row[], readCounter: ReadCounter) {
  return {
    collect: jest.fn(async () => rows),
    first: jest.fn(async () => {
      const result = rows[0] ?? null;
      if (result) readCounter.value += 1;
      return result;
    }),
    unique: jest.fn(async () => rows[0] ?? null),
    take: jest.fn(async (limit: number) => {
      const result = rows.slice(0, limit);
      readCounter.value += result.length;
      return result;
    }),
    order: jest.fn(() => createQueryResult(rows, readCounter)),
  };
}

function createQueryBuilder(
  tables: Tables,
  table: string,
  readCounter: ReadCounter,
) {
  const tableRows = () => tables[table] ?? [];

  const filterRows = (filters: Array<{ field: string; value: any }>) =>
    tableRows().filter((row) =>
      filters.every(({ field, value }) => row[field] === value),
    );

  return {
    withIndex: jest.fn((_indexName: string, build: (q: any) => any) => {
      const filters: Array<{ field: string; value: any }> = [];
      const q = {
        eq: (field: string, value: any) => {
          filters.push({ field, value });
          return q;
        },
        gte: () => q,
        lte: () => q,
      };
      build(q);
      return createQueryResult(filterRows(filters), readCounter);
    }),
    collect: jest.fn(async () => tableRows()),
    take: jest.fn(async (limit: number) => tableRows().slice(0, limit)),
    paginate: jest.fn(
      async ({
        cursor,
        numItems,
      }: {
        cursor: string | null;
        numItems: number;
      }) => {
        const start = cursor ? Number(cursor) : 0;
        const page = tableRows().slice(start, start + numItems);
        readCounter.value += page.length;
        const next = start + page.length;
        return {
          page,
          isDone: next >= tableRows().length,
          continueCursor: next >= tableRows().length ? null : String(next),
        };
      },
    ),
  };
}

function createMockCtx(tables: Tables, subject = "user_123") {
  const deletedIds: string[] = [];
  const patches: Array<{ id: string; patch: Record<string, any> }> = [];
  const readCounter: ReadCounter = { value: 0 };
  const scheduler = {
    runAfter: jest.fn().mockResolvedValue(undefined),
  };

  const db = {
    query: jest.fn((table: string) =>
      createQueryBuilder(tables, table, readCounter),
    ),
    get: jest.fn(async (id: string) => {
      readCounter.value += 1;
      for (const rows of Object.values(tables)) {
        const row = rows.find((candidate) => candidate._id === id);
        if (row) return row;
      }
      return null;
    }),
    delete: jest.fn(async (id: string) => {
      deletedIds.push(id);
      for (const [table, rows] of Object.entries(tables)) {
        const next = rows.filter((row) => row._id !== id);
        if (next.length !== rows.length) {
          tables[table] = next;
        }
      }
    }),
    patch: jest.fn(async (id: string, patch: Record<string, any>) => {
      patches.push({ id, patch });
      for (const rows of Object.values(tables)) {
        const row = rows.find((candidate) => candidate._id === id);
        if (!row) continue;
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) {
            delete row[key];
          } else {
            row[key] = value;
          }
        }
      }
    }),
  };

  return {
    ctx: {
      auth: {
        getUserIdentity: jest.fn().mockResolvedValue({ subject }),
      },
      db,
      scheduler,
    },
    db,
    scheduler,
    deletedIds,
    patches,
    readCounter,
  };
}

function seedTables(userId = "user_123", otherUserId = "user_other"): Tables {
  return {
    chats: [
      {
        _id: "chat-doc",
        id: "chat-1",
        user_id: userId,
        title: "User chat",
        latest_summary_id: "summary-latest",
        update_time: 1,
      },
      {
        _id: "chat-other",
        id: "chat-other-id",
        user_id: otherUserId,
        title: "Other chat",
        update_time: 1,
      },
    ],
    chat_summaries: [
      {
        _id: "summary-by-chat",
        chat_id: "chat-1",
        summary_text: "delete",
        summary_up_to_message_id: "msg-1",
      },
      {
        _id: "summary-latest",
        chat_id: "legacy-chat-id",
        summary_text: "delete by latest ref",
        summary_up_to_message_id: "msg-1",
      },
      {
        _id: "summary-other",
        chat_id: "chat-other-id",
        summary_text: "keep",
        summary_up_to_message_id: "msg-other",
      },
    ],
    messages: [
      {
        _id: "message-user",
        id: "msg-1",
        chat_id: "chat-1",
        user_id: userId,
        role: "user",
        parts: [],
        feedback_id: "feedback-user",
        update_time: 1,
      },
      {
        _id: "message-other",
        id: "msg-other",
        chat_id: "chat-other-id",
        user_id: otherUserId,
        role: "user",
        parts: [],
        feedback_id: "feedback-other",
        update_time: 1,
      },
    ],
    feedback: [
      { _id: "feedback-user", feedback_type: "positive" },
      { _id: "feedback-other", feedback_type: "negative" },
    ],
    files: [
      {
        _id: "file-user",
        user_id: userId,
        s3_key: "users/user_123/file.pdf",
        name: "file.pdf",
        media_type: "application/pdf",
        size: 1,
        file_token_size: 1,
        is_attached: true,
      },
      {
        _id: "file-other",
        user_id: otherUserId,
        name: "other.txt",
        media_type: "text/plain",
        size: 1,
        file_token_size: 1,
        is_attached: false,
      },
    ],
    notes: [
      { _id: "note-user", user_id: userId, note_id: "note-1" },
      { _id: "note-other", user_id: otherUserId, note_id: "note-2" },
    ],
    user_customization: [
      { _id: "custom-user", user_id: userId, updated_at: 1 },
      { _id: "custom-other", user_id: otherUserId, updated_at: 1 },
    ],
    extra_usage: [
      {
        _id: "extra-user",
        user_id: userId,
        balance_points: 100,
        updated_at: 1,
      },
      {
        _id: "extra-other",
        user_id: otherUserId,
        balance_points: 100,
        updated_at: 1,
      },
    ],
    team_member_usage: [
      {
        _id: "team-member-user",
        organization_id: "org_team",
        user_id: userId,
        updated_at: 1,
      },
      {
        _id: "team-member-other",
        organization_id: "org_team",
        user_id: otherUserId,
        updated_at: 1,
      },
    ],
    temp_streams: [
      { _id: "stream-user", chat_id: "chat-1", user_id: userId },
      { _id: "stream-other", chat_id: "chat-other-id", user_id: otherUserId },
    ],
    local_sandbox_tokens: [
      { _id: "token-user", user_id: userId, token: "secret" },
      { _id: "token-other", user_id: otherUserId, token: "keep" },
    ],
    local_sandbox_connections: [
      { _id: "connection-user", user_id: userId, connection_id: "conn-1" },
      {
        _id: "connection-other",
        user_id: otherUserId,
        connection_id: "conn-2",
      },
    ],
    cancellation_reason_details: [
      {
        _id: "cancel-detail-user",
        cancellation_reason_id: "cancel-user",
        user_id: userId,
        reason_details: "personal freeform text",
        created_at: 1,
      },
      {
        _id: "cancel-detail-other",
        cancellation_reason_id: "cancel-other",
        user_id: otherUserId,
        reason_details: "keep",
        created_at: 1,
      },
    ],
    cancellation_reasons: [
      {
        _id: "cancel-user",
        user_id: userId,
        reason_details_id: "cancel-detail-user",
        updated_at: 1,
      },
      {
        _id: "cancel-other",
        user_id: otherUserId,
        reason_details_id: "cancel-detail-other",
        updated_at: 1,
      },
    ],
    usage_logs: [
      {
        _id: "usage-user",
        user_id: userId,
        chat_id: "chat-1",
        model: "model",
        total_tokens: 10,
      },
      {
        _id: "usage-other",
        user_id: otherUserId,
        chat_id: "chat-other-id",
        model: "model",
        total_tokens: 10,
      },
    ],
    referral_codes: [
      {
        _id: "ref-code-user",
        user_id: userId,
        code: "ABC1234",
        status: "active",
        updated_at: 1,
      },
      {
        _id: "ref-code-other",
        user_id: otherUserId,
        code: "XYZ1234",
        status: "active",
        updated_at: 1,
      },
    ],
    referral_attributions: [
      {
        _id: "ref-attr-referred",
        referred_user_id: userId,
        referrer_user_id: otherUserId,
        referral_code: "XYZ1234",
        status: "attributed",
        updated_at: 1,
      },
      {
        _id: "ref-attr-referrer",
        referred_user_id: otherUserId,
        referrer_user_id: userId,
        referral_code: "ABC1234",
        status: "converted",
        updated_at: 1,
      },
    ],
    referral_rewards: [
      {
        _id: "ref-reward-user",
        idempotency_key: "reward:user",
        reward_type: "referred_signup",
        status: "awarded",
        user_id: userId,
        amount_dollars: 1,
        created_at: 1,
      },
      {
        _id: "ref-reward-referrer",
        idempotency_key: "reward:referrer",
        reward_type: "referrer_conversion",
        status: "awarded",
        referrer_user_id: userId,
        referred_user_id: otherUserId,
        amount_dollars: 1,
        created_at: 1,
      },
      {
        _id: "ref-reward-referred",
        idempotency_key: "reward:referred",
        reward_type: "referred_signup",
        status: "awarded",
        referrer_user_id: otherUserId,
        referred_user_id: userId,
        amount_dollars: 1,
        created_at: 1,
      },
    ],
    user_suspensions: [
      { _id: "suspension-user", user_id: userId, updated_at: 1 },
      { _id: "suspension-other", user_id: otherUserId, updated_at: 1 },
    ],
    revenue_events: [
      {
        _id: "revenue-user-entity",
        entity_type: "user",
        entity_id: userId,
        user_id: userId,
        source: "subscription",
      },
      {
        _id: "revenue-org-with-user",
        entity_type: "organization",
        entity_id: "org_team",
        user_id: userId,
        organization_id: "org_team",
        source: "team_extra_usage",
      },
      {
        _id: "revenue-other",
        entity_type: "user",
        entity_id: otherUserId,
        user_id: otherUserId,
        source: "subscription",
      },
    ],
    extra_usage_purchases: [
      {
        _id: "purchase-user",
        user_id: userId,
        amount_dollars: 50,
        stripe_checkout_session_id: "cs_user",
        status: "credited",
        created_at: 1,
        updated_at: 1,
      },
      {
        _id: "purchase-other",
        user_id: otherUserId,
        amount_dollars: 50,
        stripe_checkout_session_id: "cs_other",
        status: "credited",
        created_at: 1,
        updated_at: 1,
      },
    ],
    paid_start_events: [
      {
        _id: "paid-user-entity",
        entity_type: "user",
        entity_id: userId,
        user_id: userId,
        day: "2026-06-21",
      },
      {
        _id: "paid-org-with-user",
        entity_type: "organization",
        entity_id: "org_team",
        user_id: userId,
        organization_id: "org_team",
        day: "2026-06-21",
      },
    ],
    unit_economics_daily: [
      {
        _id: "unit-user-entity",
        entity_type: "user",
        entity_id: userId,
        user_id: userId,
        day: "2026-06-21",
        updated_at: 1,
      },
      {
        _id: "unit-org-with-user",
        entity_type: "organization",
        entity_id: "org_team",
        user_id: userId,
        organization_id: "org_team",
        day: "2026-06-21",
        updated_at: 1,
      },
    ],
    team_extra_usage: [
      { _id: "team-extra", organization_id: "org_team", balance_points: 1 },
    ],
    paid_start_mix_daily: [
      { _id: "paid-mix", day: "2026-06-21", tier: "pro", plan: "pro" },
    ],
    processed_webhooks: [{ _id: "webhook", event_id: "evt_1" }],
    processed_checkout_sessions: [{ _id: "checkout", session_key: "cs_1" }],
  };
}

const row = (tables: Tables, table: string, id: string) =>
  tables[table]?.find((candidate) => candidate._id === id);

describe("userDeletion", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.CONVEX_SERVICE_ROLE_KEY = "service_key";
    jest.spyOn(console, "log").mockImplementation(() => {});
    jest.spyOn(console, "error").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("deletes product data, anonymizes ledgers, and retains aggregate tables", async () => {
    const { deleteAllUserData, DELETED_USER_ID, USER_DELETION_TABLE_POLICY } =
      await import("../userDeletion");
    const tables = seedTables();
    const { ctx, scheduler, deletedIds } = createMockCtx(tables);

    await deleteAllUserData.handler(ctx as any, {});

    for (const table of USER_DELETION_TABLE_POLICY.delete) {
      expect(
        (tables[table] ?? []).some((candidate) =>
          Object.values(candidate).includes("user_123"),
        ),
      ).toBe(false);
    }

    expect(row(tables, "chats", "chat-other")).toBeTruthy();
    expect(row(tables, "feedback", "feedback-other")).toBeTruthy();
    expect(row(tables, "files", "file-other")).toBeTruthy();

    expect(row(tables, "cancellation_reasons", "cancel-user")).toMatchObject({
      user_id: DELETED_USER_ID,
    });
    expect(
      row(tables, "cancellation_reasons", "cancel-user")?.reason_details_id,
    ).toBeUndefined();
    expect(row(tables, "usage_logs", "usage-user")).toMatchObject({
      user_id: DELETED_USER_ID,
    });
    expect(row(tables, "usage_logs", "usage-user")?.chat_id).toBeUndefined();
    expect(row(tables, "referral_codes", "ref-code-user")).toMatchObject({
      user_id: DELETED_USER_ID,
      status: "deactivated",
      deactivated_reason: "account_deleted",
    });
    expect(
      row(tables, "referral_attributions", "ref-attr-referred"),
    ).toMatchObject({
      referred_user_id: DELETED_USER_ID,
      referrer_user_id: "user_other",
    });
    expect(
      row(tables, "referral_attributions", "ref-attr-referrer"),
    ).toMatchObject({
      referred_user_id: "user_other",
      referrer_user_id: DELETED_USER_ID,
    });
    expect(
      row(tables, "referral_rewards", "ref-reward-user")?.user_id,
    ).toBeUndefined();
    expect(
      row(tables, "referral_rewards", "ref-reward-referrer")?.referrer_user_id,
    ).toBeUndefined();
    expect(
      row(tables, "referral_rewards", "ref-reward-referred")?.referred_user_id,
    ).toBeUndefined();
    expect(row(tables, "user_suspensions", "suspension-user")).toMatchObject({
      user_id: DELETED_USER_ID,
    });
    expect(row(tables, "revenue_events", "revenue-user-entity")).toMatchObject({
      entity_id: DELETED_USER_ID,
    });
    expect(
      row(tables, "revenue_events", "revenue-user-entity")?.user_id,
    ).toBeUndefined();
    expect(
      row(tables, "revenue_events", "revenue-org-with-user")?.user_id,
    ).toBeUndefined();
    expect(row(tables, "extra_usage_purchases", "purchase-user")).toMatchObject(
      {
        user_id: DELETED_USER_ID,
      },
    );
    expect(
      row(tables, "extra_usage_purchases", "purchase-other"),
    ).toMatchObject({
      user_id: "user_other",
    });
    expect(row(tables, "paid_start_events", "paid-user-entity")).toMatchObject({
      entity_id: DELETED_USER_ID,
    });
    expect(
      row(tables, "unit_economics_daily", "unit-user-entity"),
    ).toMatchObject({
      entity_id: DELETED_USER_ID,
    });

    for (const table of USER_DELETION_TABLE_POLICY.retain) {
      expect(tables[table]).toHaveLength(1);
    }

    expect(mockFileCountAggregate.deleteIfExists).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ _id: "file-user" }),
    );
    expect(scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "deleteS3ObjectsBatchAction",
      { s3Keys: ["users/user_123/file.pdf"] },
    );

    expect(deletedIds.indexOf("feedback-user")).toBeLessThan(
      deletedIds.indexOf("message-user"),
    );
    expect(deletedIds.indexOf("summary-by-chat")).toBeLessThan(
      deletedIds.indexOf("chat-doc"),
    );
  });

  it("deletes user data through the service-key mutation without auth", async () => {
    const { deleteAllUserDataByService } = await import("../userDeletion");
    const tables = seedTables("service_user");
    const { ctx } = createMockCtx(tables, "ignored-auth-user");

    await deleteAllUserDataByService.handler(ctx as any, {
      serviceKey: "service_key",
      userId: "service_user",
    });

    expect(row(tables, "chats", "chat-doc")).toBeUndefined();
  });

  it("rejects service-key cleanup with an invalid key", async () => {
    const { deleteAllUserDataByService } = await import("../userDeletion");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);

    await expect(
      deleteAllUserDataByService.handler(ctx as any, {
        serviceKey: "wrong",
        userId: "user_123",
      }),
    ).rejects.toThrow("Unauthorized: Invalid service key");

    expect(row(tables, "chats", "chat-doc")).toBeTruthy();
  });

  it("dry-runs and executes orphan chat summary residue cleanup", async () => {
    const { cleanupDeletedUserResidue } = await import("../userDeletion");
    const tables = seedTables();
    tables.chat_summaries.push({
      _id: "summary-orphan",
      chat_id: "missing-chat",
      summary_text: "orphan",
      summary_up_to_message_id: "msg-missing",
    });
    const { ctx } = createMockCtx(tables);

    const pagedDryRun = await cleanupDeletedUserResidue.handler(ctx as any, {
      serviceKey: "service_key",
      deleteOrphanChatSummaries: true,
      orphanNumItems: 1,
    });

    expect(pagedDryRun.hasMore).toBe(true);
    expect(pagedDryRun.orphanChatSummariesIsDone).toBe(false);
    expect(pagedDryRun.orphanChatSummariesContinueCursor).toBe("1");

    const dryRun = await cleanupDeletedUserResidue.handler(ctx as any, {
      serviceKey: "service_key",
      deleteOrphanChatSummaries: true,
      orphanNumItems: 20,
    });

    expect(dryRun.hasMore).toBe(false);
    expect(dryRun.orphanChatSummariesDeleted).toBe(2);
    expect(row(tables, "chat_summaries", "summary-orphan")).toBeTruthy();
    expect(row(tables, "chat_summaries", "summary-latest")).toBeTruthy();

    const execute = await cleanupDeletedUserResidue.handler(ctx as any, {
      serviceKey: "service_key",
      deleteOrphanChatSummaries: true,
      dryRun: false,
      orphanNumItems: 20,
    });

    expect(execute.hasMore).toBe(false);
    expect(execute.orphanChatSummariesDeleted).toBe(2);
    expect(row(tables, "chat_summaries", "summary-orphan")).toBeUndefined();
    expect(row(tables, "chat_summaries", "summary-latest")).toBeUndefined();
    expect(row(tables, "chat_summaries", "summary-other")).toBeTruthy();
  });

  it("rejects bulk deleted-user residue cleanup in one transaction", async () => {
    const { cleanupDeletedUserResidue } = await import("../userDeletion");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);

    await expect(
      cleanupDeletedUserResidue.handler(ctx as any, {
        serviceKey: "service_key",
        userIds: ["user_123", "user_other"],
      }),
    ).rejects.toThrow("processes one userId per mutation");
  });

  it("rejects combined user and orphan-summary residue cleanup", async () => {
    const { cleanupDeletedUserResidue } = await import("../userDeletion");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);

    await expect(
      cleanupDeletedUserResidue.handler(ctx as any, {
        serviceKey: "service_key",
        userIds: ["user_123"],
        deleteOrphanChatSummaries: true,
      }),
    ).rejects.toThrow("separate mutations");
  });

  it("keeps cleanup reads bounded and preserves chats until a later message batch", async () => {
    const { deleteAllUserData } = await import("../userDeletion");
    const tables = seedTables();
    tables.feedback = Array.from({ length: 101 }, (_, index) => ({
      _id: `feedback-user-${index}`,
      feedback_type: "positive",
    }));
    tables.messages = Array.from({ length: 101 }, (_, index) => ({
      _id: `message-user-${index}`,
      id: `msg-${index}`,
      chat_id: "chat-1",
      user_id: "user_123",
      role: "user",
      parts: [{ type: "text", text: "large message payload" }],
      feedback_id: `feedback-user-${index}`,
      update_time: index,
    }));
    const { ctx, readCounter } = createMockCtx(tables);

    const firstBatch = await deleteAllUserData.handler(ctx as any, {});
    const firstBatchReads = readCounter.value;

    expect(firstBatch.hasMore).toBe(true);
    expect(
      tables.messages.filter((candidate) => candidate.user_id === "user_123"),
    ).toHaveLength(52);
    expect(tables.feedback).toHaveLength(52);
    expect(firstBatchReads).toBeLessThanOrEqual(100);
    expect(row(tables, "chats", "chat-doc")).toBeTruthy();

    const secondBatch = await deleteAllUserData.handler(ctx as any, {});
    const secondBatchReads = readCounter.value - firstBatchReads;

    expect(secondBatch.hasMore).toBe(true);
    expect(
      tables.messages.filter((candidate) => candidate.user_id === "user_123"),
    ).toHaveLength(3);
    expect(tables.feedback).toHaveLength(3);
    expect(secondBatchReads).toBeLessThanOrEqual(100);
    expect(row(tables, "chats", "chat-doc")).toBeTruthy();

    const thirdBatch = await deleteAllUserData.handler(ctx as any, {});
    const thirdBatchReads =
      readCounter.value - firstBatchReads - secondBatchReads;

    expect(thirdBatch.hasMore).toBe(false);
    expect(
      tables.messages.filter((candidate) => candidate.user_id === "user_123"),
    ).toHaveLength(0);
    expect(tables.feedback).toHaveLength(0);
    expect(thirdBatchReads).toBeLessThanOrEqual(100);
    expect(row(tables, "chats", "chat-doc")).toBeUndefined();
  });

  it("fails user deletion if S3 cleanup scheduling fails", async () => {
    const { deleteAllUserData } = await import("../userDeletion");
    const tables = seedTables();
    const { ctx, scheduler } = createMockCtx(tables);
    scheduler.runAfter.mockRejectedValueOnce(new Error("Scheduler error"));

    await expect(deleteAllUserData.handler(ctx as any, {})).rejects.toThrow(
      "Scheduler error",
    );

    expect(scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "deleteS3ObjectsBatchAction",
      { s3Keys: ["users/user_123/file.pdf"] },
    );
  });

  it("throws if the public mutation has no authenticated user", async () => {
    const { deleteAllUserData } = await import("../userDeletion");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    ctx.auth.getUserIdentity.mockResolvedValueOnce(null);

    await expect(deleteAllUserData.handler(ctx as any, {})).rejects.toThrow(
      "Unauthorized: User not authenticated",
    );
  });
});
