jest.mock("../_generated/api", () => ({
  internal: {
    findings: {
      backfillFindingProjects: "backfillFindingProjects",
      syncChatFindingProject: "syncChatFindingProject",
    },
  },
}));
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
  mutation: jest.fn((config: any) => config),
  internalMutation: jest.fn((config: any) => config),
  query: jest.fn((config: any) => config),
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

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

jest.mock("../lib/suspensionGuards", () => ({
  assertUserCanAccessChatHistory: jest.fn().mockResolvedValue(undefined),
}));

type Row = { _id: string; [key: string]: any };
type Tables = Record<string, Row[]>;

const report = (overrides: Record<string, unknown> = {}) => ({
  title: "Cross-tenant invoice access",
  description: "An authenticated user can read another user's invoice.",
  impact: "A user can disclose another customer's billing address.",
  target: "https://app.example.test",
  endpoint: "/api/invoices/:id",
  method: "get",
  cwe: "CWE-639",
  technical_analysis: "The handler loads by id without an owner check.",
  poc_description: "Request user B's invoice while signed in as user A.",
  poc_script_code: "curl -H 'Authorization: Bearer user-a' /api/invoices/b",
  remediation_steps: "Scope the invoice query to the authenticated user.",
  evidence: "The response returned user B's billing address.",
  assumptions: "Both accounts are ordinary customer accounts.",
  confidence: "high",
  counterevidence: "An owner check was absent on the tested path.",
  severity_change_conditions:
    "A verified owner check would rule out this path.",
  fix_effort: "low",
  cvss_breakdown: {
    attack_vector: "N",
    attack_complexity: "L",
    privileges_required: "L",
    user_interaction: "N",
    scope: "U",
    confidentiality: "H",
    integrity: "N",
    availability: "N",
  },
  ...overrides,
});

const seedTables = (): Tables => ({
  chats: [
    {
      _id: "chat-doc-1",
      id: "chat-1",
      user_id: "user-1",
      title: "Invoice test",
      update_time: 1,
    },
    {
      _id: "chat-doc-2",
      id: "chat-2",
      user_id: "user-1",
      title: "Retest",
      update_time: 2,
    },
    {
      _id: "chat-doc-other",
      id: "chat-other",
      user_id: "other-user",
      title: "Private other chat",
      update_time: 3,
    },
  ],
  messages: [
    {
      _id: "message-doc-1",
      id: "message-1",
      chat_id: "chat-1",
      user_id: "user-1",
      role: "assistant",
      parts: [
        { type: "text", text: "Confirmed." },
        {
          type: "tool-create_vulnerability_report",
          toolCallId: "tool-1",
          state: "output-available",
          input: report(),
          output: { success: true, finding_id: "finding-public-1" },
        },
        { type: "text", text: "Saved." },
      ],
      update_time: 1,
    },
  ],
  findings: [],
  finding_sources: [],
});

function createResult(
  rows: Row[],
  filters: Array<[string, unknown]>,
  paginationFailure?: unknown,
) {
  const filtered = () =>
    rows.filter((row) =>
      filters.every(([field, value]) => row[field] === value),
    );
  const result: any = {
    first: jest.fn(async () => filtered()[0] ?? null),
    unique: jest.fn(async () => {
      const matches = filtered();
      if (matches.length > 1) throw new Error("Expected a unique result");
      return matches[0] ?? null;
    }),
    collect: jest.fn(async () => filtered()),
    take: jest.fn(async (limit: number) => filtered().slice(0, limit)),
    order: jest.fn((direction: "asc" | "desc") => {
      rows = [...filtered()].sort((a, b) =>
        direction === "desc"
          ? (b.latest_finding_at ?? b.created_at ?? 0) -
            (a.latest_finding_at ?? a.created_at ?? 0)
          : (a.latest_finding_at ?? a.created_at ?? 0) -
            (b.latest_finding_at ?? b.created_at ?? 0),
      );
      filters = [];
      return result;
    }),
    filter: jest.fn((build: (q: any) => any) => {
      const q: any = {
        field: (field: string) => field,
        eq: (field: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
      };
      build(q);
      return result;
    }),
    paginate: jest.fn(
      async ({
        cursor,
        numItems,
      }: {
        cursor: string | null;
        numItems: number;
      }) => {
        if (paginationFailure !== undefined) throw paginationFailure;
        const all = filtered();
        const start = cursor ? Number(cursor) : 0;
        const page = all.slice(start, start + numItems);
        const next = start + page.length;
        return {
          page,
          isDone: next >= all.length,
          continueCursor: next >= all.length ? "" : String(next),
        };
      },
    ),
    async *[Symbol.asyncIterator]() {
      for (const row of filtered()) yield row;
    },
  };
  return result;
}

function createMockCtx(
  tables: Tables,
  subject = "user-1",
  paginationFailure?: unknown,
) {
  let nextId = 1;
  const indexes: string[] = [];
  const query = jest.fn((table: string) => ({
    order: jest.fn((direction: "asc" | "desc") =>
      createResult(tables[table] ?? [], [], paginationFailure).order(direction),
    ),
    withIndex: jest.fn((index: string, build: (q: any) => any) => {
      indexes.push(index);
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        eq: (field: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
      };
      build(q);
      return createResult(tables[table] ?? [], filters, paginationFailure);
    }),
    withSearchIndex: jest.fn((_index: string, build: (q: any) => any) => {
      const filters: Array<[string, unknown]> = [];
      let search = "";
      const q: any = {
        search: (_field: string, value: string) => {
          search = value.toLowerCase();
          return q;
        },
        eq: (field: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
      };
      build(q);
      const rows = (tables[table] ?? []).filter((row) =>
        String(row.search_text ?? "")
          .toLowerCase()
          .includes(search),
      );
      return createResult(rows, filters, paginationFailure);
    }),
  }));
  const insert = jest.fn(async (table: string, value: Record<string, any>) => {
    const row = { _id: `${table}-${nextId++}`, ...value };
    (tables[table] ??= []).push(row);
    return row._id;
  });
  const patch = jest.fn(async (id: string, value: Record<string, any>) => {
    for (const rows of Object.values(tables)) {
      const row = rows.find((candidate) => candidate._id === id);
      if (row) Object.assign(row, value);
    }
  });
  const deleteDoc = jest.fn(async (id: string) => {
    for (const [table, rows] of Object.entries(tables)) {
      tables[table] = rows.filter((candidate) => candidate._id !== id);
    }
  });

  return {
    ctx: {
      auth: {
        getUserIdentity: jest
          .fn()
          .mockResolvedValue(subject ? { subject } : null),
      },
      db: {
        query,
        insert,
        patch,
        delete: deleteDoc,
        get: jest.fn(
          async (id: string) =>
            Object.values(tables)
              .flat()
              .find((row) => row._id === id) ?? null,
        ),
      },
      scheduler: { runAfter: jest.fn() },
    } as any,
    insert,
    patch,
    deleteDoc,
    indexes,
  };
}

const createArgs = (overrides: Record<string, unknown> = {}) => ({
  serviceKey: "service-key",
  userId: "user-1",
  chatId: "chat-1",
  messageId: "message-1",
  toolCallId: "tool-1",
  report: report(),
  ...overrides,
});

describe("findings Convex lifecycle", () => {
  beforeEach(() => jest.clearAllMocks());

  it("retains assessment limits through save, reopen, export, close, and delete", async () => {
    const { createFindingForBackend, getFinding, closeFinding, deleteFinding } =
      await import("../findings");
    const { renderFindingMarkdown } =
      await import("../../lib/findings/markdown");
    const { sanitizeFindingPartsForShare } =
      await import("../../lib/findings/share-sanitizer");
    const assessment = {
      confidence: "medium" as const,
      confidence_rationale: "Only the synthetic invoice was tested.",
      counterevidence:
        "The control account was denied; only the cross-tenant request returned the synthetic invoice.",
      severity_change_conditions:
        "An enforced tenant boundary would rule out this finding; broader exposed records would raise impact.",
    };
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    const input = report(assessment);
    const result = await createFindingForBackend.handler(
      ctx,
      createArgs({ report: input }),
    );
    if (!result.success) throw new Error("Expected saved finding");
    const reopened = await getFinding.handler(createMockCtx(tables).ctx, {
      findingId: result.finding_id,
    });
    expect(reopened).toMatchObject(assessment);
    expect(
      await getFinding.handler(createMockCtx(tables, "other-user").ctx, {
        findingId: result.finding_id,
      }),
    ).toBeNull();
    const markdown = renderFindingMarkdown(reopened!);
    expect(markdown).toContain("Assessment confidence: medium");
    expect(markdown).toContain(assessment.counterevidence);
    expect(markdown).toContain(assessment.severity_change_conditions);
    const shared = sanitizeFindingPartsForShare([
      {
        type: "tool-create_vulnerability_report",
        state: "output-available",
        input,
        output: result,
      },
    ]);
    expect(JSON.stringify(shared)).not.toMatch(
      /confidence|counterevidence|severity_change_conditions/,
    );
    await closeFinding.handler(ctx, {
      findingId: result.finding_id,
      reason: "already_fixed",
      context: "Synthetic retest passed.",
    });
    const closed = await getFinding.handler(ctx, {
      findingId: result.finding_id,
    });
    expect(renderFindingMarkdown(closed!)).toContain(
      "Synthetic retest passed.",
    );
    expect(closed).toMatchObject(assessment);
    await deleteFinding.handler(ctx, { findingId: result.finding_id });
    expect(
      await getFinding.handler(ctx, { findingId: result.finding_id }),
    ).toBeNull();
  });

  it("persists server-derived provenance, score, severity, search, and dedupe", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx, insert } = createMockCtx(tables);

    const result = await createFindingForBackend.handler(ctx, createArgs());

    expect(result).toMatchObject({
      success: true,
      title: "Cross-tenant invoice access",
      target: "https://app.example.test",
      endpoint: "/api/invoices/:id",
      severity: "medium",
      cvss_score: 6.5,
    });
    expect(insert).toHaveBeenCalledWith(
      "findings",
      expect.objectContaining({
        user_id: "user-1",
        chat_id: "chat-1",
        message_id: "message-1",
        tool_call_id: "tool-1",
        method: "GET",
        severity: "medium",
        category: "access_control",
        status: "active",
        cvss_score: 6.5,
        cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
        dedupe_key: expect.any(String),
        search_text: expect.stringMatching(
          /CWE-639[\s\S]*Access Control \/ IDOR/,
        ),
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      }),
    );
    expect(insert).toHaveBeenCalledWith("finding_sources", {
      user_id: "user-1",
      chat_id: "chat-1",
      chat_title: "Invoice test",
      finding_count: 1,
      latest_finding_at: expect.any(Number),
    });
  });

  it("rejects a missing, deleted, or foreign source chat", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);

    await expect(
      createFindingForBackend.handler(
        ctx,
        createArgs({ chatId: "missing-chat" }),
      ),
    ).resolves.toMatchObject({ success: false, error: "chat_not_found" });
    await expect(
      createFindingForBackend.handler(
        ctx,
        createArgs({ chatId: "chat-other" }),
      ),
    ).resolves.toMatchObject({ success: false, error: "chat_not_found" });
    tables.chats[0].deletion_started_at = Date.now();
    await expect(
      createFindingForBackend.handler(ctx, createArgs()),
    ).resolves.toMatchObject({ success: false, error: "chat_not_found" });
  });

  it("rejects findings after a run is canceled", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    tables.chats[0].canceled_at = Date.now();
    const { ctx, insert } = createMockCtx(tables);
    await expect(
      createFindingForBackend.handler(ctx, createArgs()),
    ).resolves.toMatchObject({ success: false, error: "chat_not_found" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("deduplicates normalized reports in one chat but permits another chat", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);

    await createFindingForBackend.handler(ctx, createArgs());
    const duplicate = await createFindingForBackend.handler(
      ctx,
      createArgs({
        toolCallId: "tool-2",
        report: report({
          title: "  CROSS-TENANT   invoice access ",
          target: "HTTPS://APP.EXAMPLE.TEST",
          method: "GET",
          cwe: "CWE-639",
        }),
      }),
    );
    const crossChat = await createFindingForBackend.handler(
      ctx,
      createArgs({
        chatId: "chat-2",
        messageId: "message-2",
        toolCallId: "tool-3",
      }),
    );
    const secondInSourceChat = await createFindingForBackend.handler(
      ctx,
      createArgs({
        toolCallId: "tool-4",
        report: report({ title: "Cross-tenant invoice modification" }),
      }),
    );

    expect(duplicate).toMatchObject({ success: false, error: "duplicate" });
    expect(crossChat).toMatchObject({ success: true });
    expect(secondInSourceChat).toMatchObject({ success: true });
    expect(tables.findings).toHaveLength(3);
    expect(tables.finding_sources).toHaveLength(2);
    expect(
      tables.finding_sources.find((source) => source.chat_id === "chat-1"),
    ).toMatchObject({ finding_count: 2 });
  });

  it("paginates newest-first and applies ownership, severity, chat, and search", async () => {
    const { listFindings } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-old",
        finding_id: "old",
        user_id: "user-1",
        chat_id: "chat-1",
        title: "Old SQL injection",
        target: "api.example.test",
        category: "injection",
        status: "active",
        severity: "critical",
        cvss_score: 9.8,
        search_text: "Old SQL injection api.example.test CWE-89",
        created_at: 10,
      },
      {
        _id: "finding-new",
        finding_id: "new",
        user_id: "user-1",
        chat_id: "chat-2",
        title: "New IDOR",
        target: "app.example.test",
        category: "access_control",
        status: "closed",
        severity: "high",
        cvss_score: 7.1,
        search_text: "New IDOR app.example.test /invoices CWE-639",
        created_at: 20,
      },
      {
        _id: "finding-other",
        finding_id: "other",
        user_id: "other-user",
        chat_id: "chat-other",
        title: "Other private finding",
        target: "private.test",
        category: "other",
        status: "active",
        severity: "critical",
        cvss_score: 10,
        search_text: "Other private finding",
        created_at: 30,
      },
    ];
    const { ctx, indexes } = createMockCtx(tables);

    const first = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 1 },
    });
    expect(first.page.map((item: any) => item.finding_id)).toEqual(["new"]);
    expect(first.isDone).toBe(false);

    const second = await listFindings.handler(ctx, {
      paginationOpts: { cursor: first.continueCursor, numItems: 1 },
    });
    expect(second.page.map((item: any) => item.finding_id)).toEqual(["old"]);

    const filtered = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      severity: "critical",
      chatId: "chat-1",
    });
    expect(filtered.page.map((item: any) => item.finding_id)).toEqual(["old"]);
    expect(indexes).toContain("by_user_severity_chat_created");

    const lifecycleFiltered = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      status: "closed",
      category: "access_control",
      severity: "high",
      chatId: "chat-2",
    });
    expect(lifecycleFiltered.page.map((item: any) => item.finding_id)).toEqual([
      "new",
    ]);
    expect(indexes).toContain("by_user_status_category_severity_chat_created");

    const searched = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      search: "CWE-639",
    });
    expect(searched.page.map((item: any) => item.finding_id)).toEqual(["new"]);
  });

  it("derives lifecycle metadata when reading a pre-lifecycle finding", async () => {
    const { listFindings } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-legacy",
        finding_id: "legacy",
        user_id: "user-1",
        chat_id: "chat-1",
        title: "SQL injection in the login handler",
        target: "api.example.test",
        cwe: "CWE-89",
        severity: "critical",
        cvss_score: 9.8,
        search_text: "SQL injection api.example.test CWE-89",
        created_at: 10,
      },
    ];
    const { ctx } = createMockCtx(tables);

    const result = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
    });

    expect(result.page).toEqual([
      expect.objectContaining({
        finding_id: "legacy",
        category: "injection",
        status: "active",
      }),
    ]);
  });

  it("lists only source chats that contain the user's findings", async () => {
    const { getFindingSourceChats } = await import("../findings");
    const tables = seedTables();
    tables.finding_sources = [
      {
        _id: "finding-source-1",
        user_id: "user-1",
        chat_id: "chat-1",
        chat_title: "Invoice test",
        finding_count: 1,
        latest_finding_at: 10,
      },
      {
        _id: "finding-source-2",
        user_id: "user-1",
        chat_id: "chat-2",
        chat_title: "Retest",
        finding_count: 2,
        latest_finding_at: 20,
      },
      {
        _id: "finding-source-other",
        user_id: "other-user",
        chat_id: "chat-other",
        chat_title: "Private other chat",
        finding_count: 1,
        latest_finding_at: 30,
      },
    ];
    tables.chats.push({
      _id: "chat-doc-empty",
      id: "chat-empty",
      user_id: "user-1",
      title: "No findings here",
      update_time: 99,
    });
    const { ctx, indexes } = createMockCtx(tables);

    await expect(getFindingSourceChats.handler(ctx, {})).resolves.toEqual([
      { chat_id: "chat-2", chat_title: "Retest" },
      { chat_id: "chat-1", chat_title: "Invoice test" },
    ]);
    expect(indexes).toContain("by_user_and_latest");
    expect(indexes).not.toContain("by_user_and_created");
  });

  it("bounds source-chat metadata reads", async () => {
    const { getFindingSourceChats } = await import("../findings");
    const tables = seedTables();
    tables.finding_sources = Array.from({ length: 501 }, (_, index) => ({
      _id: `finding-source-${index}`,
      user_id: "user-1",
      chat_id: `chat-${index}`,
      chat_title: `Chat ${index}`,
      finding_count: 1,
      latest_finding_at: index,
    }));
    const { ctx } = createMockCtx(tables);

    const sources = await getFindingSourceChats.handler(ctx, {});

    expect(sources).toHaveLength(500);
    expect(sources[0]).toEqual({
      chat_id: "chat-500",
      chat_title: "Chat 500",
    });
  });

  it("enforces read ownership", async () => {
    const { getFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-other",
        finding_id: "other",
        user_id: "other-user",
        chat_id: "chat-other",
        title: "Private",
      },
    ];
    const { ctx } = createMockCtx(tables);
    await expect(getFinding.handler(ctx, { findingId: "other" })).resolves.toBe(
      null,
    );
  });

  it("closes an owned finding with a reason and context without deleting it", async () => {
    const { closeFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-doc-1",
        finding_id: "finding-public-1",
        user_id: "user-1",
        status: "active",
        updated_at: 1,
      },
    ];
    const { ctx, patch, deleteDoc } = createMockCtx(tables);

    await expect(
      closeFinding.handler(ctx, {
        findingId: "finding-public-1",
        reason: "already_fixed",
        context: "  Confirmed fixed in the July retest.  ",
      }),
    ).resolves.toMatchObject({ closed: true, closed_at: expect.any(Number) });
    expect(patch).toHaveBeenCalledWith(
      "finding-doc-1",
      expect.objectContaining({
        status: "closed",
        closure_reason: "already_fixed",
        closure_context: "Confirmed fixed in the July retest.",
        closed_at: expect.any(Number),
        updated_at: expect.any(Number),
      }),
    );
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(tables.messages[0].parts).toHaveLength(3);
  });

  it("rejects invalid, repeated, and foreign closure requests", async () => {
    const { closeFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-doc-closed",
        finding_id: "finding-closed",
        user_id: "user-1",
        status: "closed",
      },
      {
        _id: "finding-doc-other",
        finding_id: "finding-other",
        user_id: "other-user",
        status: "active",
      },
    ];
    const { ctx, patch } = createMockCtx(tables);

    await expect(
      closeFinding.handler(ctx, {
        findingId: "finding-closed",
        reason: "wont_fix",
        context: "Already accepted.",
      }),
    ).resolves.toEqual({ closed: false, already_closed: true });
    await expect(
      closeFinding.handler(ctx, {
        findingId: "finding-closed",
        reason: "wont_fix",
        context: "   ",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "INVALID_CLOSURE" }),
    });
    await expect(
      closeFinding.handler(ctx, {
        findingId: "finding-other",
        reason: "false_positive",
        context: "Not reproducible.",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "ACCESS_DENIED" }),
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it("deletes an owned finding and scrubs its structured source tool part", async () => {
    const { deleteFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-doc-1",
        finding_id: "finding-public-1",
        user_id: "user-1",
        chat_id: "chat-1",
        message_id: "message-1",
        tool_call_id: "tool-1",
      },
    ];
    tables.finding_sources = [
      {
        _id: "finding-source-1",
        user_id: "user-1",
        chat_id: "chat-1",
        chat_title: "Invoice test",
        finding_count: 1,
        latest_finding_at: 1,
      },
    ];
    const { ctx, patch, deleteDoc } = createMockCtx(tables);

    await expect(
      deleteFinding.handler(ctx, { findingId: "finding-public-1" }),
    ).resolves.toEqual({ deleted: true });
    expect(patch).toHaveBeenCalledWith(
      "message-doc-1",
      expect.objectContaining({
        parts: [
          { type: "text", text: "Confirmed." },
          { type: "text", text: "Saved." },
        ],
      }),
    );
    expect(deleteDoc).toHaveBeenCalledWith("finding-doc-1");
    expect(deleteDoc).toHaveBeenCalledWith("finding-source-1");
  });

  it("keeps source metadata while another finding remains in the chat", async () => {
    const { deleteFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-doc-1",
        finding_id: "finding-public-1",
        user_id: "user-1",
        chat_id: "chat-1",
        message_id: "message-1",
        tool_call_id: "tool-1",
        created_at: 10,
      },
      {
        _id: "finding-doc-2",
        finding_id: "finding-public-2",
        user_id: "user-1",
        chat_id: "chat-1",
        message_id: "message-2",
        tool_call_id: "tool-2",
        created_at: 20,
      },
    ];
    tables.finding_sources = [
      {
        _id: "finding-source-1",
        user_id: "user-1",
        chat_id: "chat-1",
        chat_title: "Invoice test",
        finding_count: 2,
        latest_finding_at: 20,
      },
    ];
    const { ctx, patch, deleteDoc } = createMockCtx(tables);

    await deleteFinding.handler(ctx, { findingId: "finding-public-2" });

    expect(deleteDoc).toHaveBeenCalledWith("finding-doc-2");
    expect(deleteDoc).not.toHaveBeenCalledWith("finding-source-1");
    expect(patch).toHaveBeenCalledWith("finding-source-1", {
      finding_count: 1,
      latest_finding_at: 10,
    });
  });

  it("rejects deletion by a different user", async () => {
    const { deleteFinding } = await import("../findings");
    const tables = seedTables();
    tables.findings = [
      {
        _id: "finding-doc-other",
        finding_id: "finding-other",
        user_id: "other-user",
        chat_id: "chat-other",
        message_id: "message-other",
        tool_call_id: "tool-other",
      },
    ];
    const { ctx, deleteDoc } = createMockCtx(tables);
    await expect(
      deleteFinding.handler(ctx, { findingId: "finding-other" }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "ACCESS_DENIED" }),
    });
    expect(deleteDoc).not.toHaveBeenCalled();
  });
  it("retains verification gaps in the owned report after reload", async () => {
    const { createFindingForBackend, getFinding } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    const evidenceVerification = {
      checked_refs: ["/tmp/control.http"],
      unavailable_refs: ["/tmp/exploit.http"],
      warning: "Evidence service unavailable; reference not verified.",
    };
    const result = await createFindingForBackend.handler(
      ctx,
      createArgs({
        report: report({ evidence_refs: ["/tmp/control.http"] }),
        evidenceVerification,
      }),
    );
    expect(result).toMatchObject({
      success: true,
      warning: evidenceVerification.warning,
    });
    const restored = await getFinding.handler(ctx, {
      findingId: result.finding_id,
    });
    expect(restored).toMatchObject({
      evidence_refs: ["/tmp/control.http"],
      evidence_verification: evidenceVerification,
    });
    const other = createMockCtx(tables, "other-user");
    expect(
      await getFinding.handler(other.ctx, { findingId: result.finding_id }),
    ).toBeNull();
  });
});

describe("chat-scoped Agent report retrieval and correction", () => {
  beforeEach(() => jest.clearAllMocks());
  async function setup() {
    const api = await import("../findings");
    const tables = seedTables();
    const mock = createMockCtx(tables);
    const saved = await api.createFindingForBackend.handler(
      mock.ctx,
      createArgs(),
    );
    if (!saved.success) throw new Error("Expected finding");
    const row = tables.findings[0];
    const scope = {
      serviceKey: "service-key",
      userId: "user-1",
      chatId: "chat-1",
    };
    const updateArgs = (
      changes: Record<string, unknown>,
      overrides: Record<string, unknown> = {},
    ) => ({
      ...scope,
      messageId: "update-message",
      toolCallId: "update-call",
      update: {
        finding_id: saved.finding_id,
        expected_updated_at: row.updated_at,
        reason: "Correct the demonstrated impact",
        changes,
      },
      ...overrides,
    });
    return { api, tables, mock, saved, row, scope, updateArgs };
  }

  it("bounds correction history and preserves it on rejected writes", async () => {
    const { api, mock, row, updateArgs } = await setup();
    const original = { id: row.finding_id, created: row.created_at };
    for (let i = 0; i < 22; i++) {
      expect(
        await api.updateFindingForBackend.handler(
          mock.ctx,
          updateArgs({ impact: `Impact ${i}` }),
        ),
      ).toMatchObject({ success: true });
    }
    expect(row.correction_count).toBe(22);
    expect(row.correction_history).toHaveLength(20);
    expect(row.correction_history[19]).toMatchObject({
      changed_fields: ["impact"],
      message_id: "update-message",
      previous_severity: row.severity,
    });
    expect(row.finding_id).toBe(original.id);
    expect(row.created_at).toBe(original.created);
    const before = JSON.stringify(row);
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ confidence: null }),
      ),
    ).toMatchObject({ success: false, error: "validation" });
    const stale = updateArgs({ impact: "stale" });
    stale.update.expected_updated_at = 0;
    expect(
      await api.updateFindingForBackend.handler(mock.ctx, stale),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(JSON.stringify(row)).toBe(before);
    const { renderFindingMarkdown } =
      await import("../../lib/findings/markdown");
    const reopened = await api.getFinding.handler(mock.ctx, {
      findingId: row.finding_id,
    });
    expect(renderFindingMarkdown(reopened!)).toContain(
      "Correct the demonstrated impact",
    );
  });

  it("records method changes after normalization", async () => {
    const { api, mock, row, updateArgs } = await setup();
    expect(row.method).toBe("GET");
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ method: "get" }),
      ),
    ).toMatchObject({ success: true });
    expect(row.method).toBe("GET");
    expect(row.correction_history[0].changed_fields).toEqual([]);
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ method: "post" }),
      ),
    ).toMatchObject({ success: true });
    expect(row.method).toBe("POST");
    expect(row.correction_history[1].changed_fields).toEqual(["method"]);
  });

  it("requires missing assessment fields when correcting a legacy report", async () => {
    const { api, mock, row, updateArgs } = await setup();
    delete row.confidence;
    delete row.counterevidence;
    delete row.severity_change_conditions;
    expect(
      await api.getFinding.handler(mock.ctx, { findingId: row.finding_id }),
    ).not.toBeNull();
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ impact: "Corrected" }),
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(row.correction_history).toBeUndefined();
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({
          impact: "Corrected",
          confidence: "medium",
          confidence_rationale: "Only one synthetic control was tested.",
          counterevidence: "The other control was denied.",
          severity_change_conditions:
            "An owner check would rule out this path.",
        }),
      ),
    ).toMatchObject({ success: true });
  });

  it("authenticates revision-specific feedback, deduplicates retries and preserves report version", async () => {
    const { api, tables, mock, row, updateArgs } = await setup();
    const args = {
      findingId: row.finding_id,
      expectedUpdatedAt: row.updated_at,
      answer: "useful" as const,
    };
    const version = row.updated_at;
    expect(
      await api.submitFindingFeedback.handler(
        createMockCtx(tables, "other-user").ctx,
        args,
      ),
    ).toEqual({ success: false, error: "not_found" });
    const unauthenticated = createMockCtx(tables);
    unauthenticated.ctx.auth.getUserIdentity.mockResolvedValueOnce(null);
    await expect(
      api.submitFindingFeedback.handler(unauthenticated.ctx, args),
    ).rejects.toThrow();
    expect(await api.submitFindingFeedback.handler(mock.ctx, args)).toEqual({
      success: true,
      changed: true,
    });
    expect(await api.submitFindingFeedback.handler(mock.ctx, args)).toEqual({
      success: true,
      changed: false,
    });
    expect(row.updated_at).toBe(version);
    expect(row.usefulness_feedback).toMatchObject({
      answer: "useful",
      report_updated_at: version,
    });
    await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({ impact: "Revised impact" }),
    );
    expect(
      await api.submitFindingFeedback.handler(mock.ctx, {
        ...args,
        answer: "needs_correction",
      }),
    ).toEqual({ success: false, error: "conflict" });
    expect(row.usefulness_feedback.answer).toBe("useful");
    expect(row.usefulness_feedback.report_updated_at).not.toBe(row.updated_at);
    tables.chats[0].deletion_started_at = 1;
    expect(
      await api.submitFindingFeedback.handler(mock.ctx, {
        ...args,
        expectedUpdatedAt: row.updated_at,
      }),
    ).toEqual({ success: false, error: "not_found" });
  });

  it("lists bounded metadata, reads and corrects the same finding, and reopens/exports the correction", async () => {
    const { api, tables, mock, row, scope, updateArgs } = await setup();
    const original = {
      id: row.finding_id,
      created: row.created_at,
      message: row.message_id,
      tool: row.tool_call_id,
    };
    const listed = await api.listReportsForBackend.handler(mock.ctx, {
      ...scope,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(listed).toMatchObject({
      success: true,
      is_done: true,
      next_cursor: null,
      reports: [{ finding_id: original.id }],
    });
    expect(JSON.stringify(listed)).not.toMatch(
      /poc_script_code|technical_analysis|evidence/,
    );
    const current = await api.getReportForBackend.handler(mock.ctx, {
      ...scope,
      findingId: original.id,
    });
    expect(current).toMatchObject({
      success: true,
      report: {
        poc_script_code: row.poc_script_code,
        updated_at: row.updated_at,
      },
    });
    const result = await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({
        title: "Limited invoice disclosure",
        impact: "Only one synthetic address was disclosed.",
        cvss_breakdown: { ...row.cvss_breakdown, confidentiality: "L" },
      }),
    );
    expect(result).toMatchObject({
      success: true,
      finding_id: original.id,
      severity: "medium",
    });
    expect(tables.findings).toHaveLength(1);
    expect(tables.finding_sources[0].finding_count).toBe(1);
    expect(row).toMatchObject({
      finding_id: original.id,
      created_at: original.created,
      message_id: original.message,
      tool_call_id: original.tool,
      title: "Limited invoice disclosure",
      last_update: {
        message_id: "update-message",
        tool_call_id: "update-call",
        reason: "Correct the demonstrated impact",
      },
    });
    expect(row.search_text).toContain("Limited invoice disclosure");
    const reloaded = await api.getFinding.handler(createMockCtx(tables).ctx, {
      findingId: original.id,
    });
    const { renderFindingMarkdown } =
      await import("../../lib/findings/markdown");
    expect(renderFindingMarkdown(reloaded!)).toContain(
      "Only one synthetic address was disclosed.",
    );
    expect(row.updated_at).toBeGreaterThan(
      current.success ? current.report.updated_at : Infinity,
    );
  });

  it("never returns or mutates another user's report or another chat's report", async () => {
    const { api, tables, mock, row, scope, updateArgs } = await setup();
    const before = JSON.stringify(row);
    for (const alternate of [
      { userId: "other-user", chatId: "chat-other" },
      { userId: "user-1", chatId: "chat-2" },
    ]) {
      const read = await api.getReportForBackend.handler(mock.ctx, {
        ...scope,
        ...alternate,
        findingId: row.finding_id,
      });
      expect(read).toEqual({
        success: false,
        error: "not_found",
        message: "The report is not available in this chat.",
      });
      expect(
        await api.updateFindingForBackend.handler(
          mock.ctx,
          updateArgs({ title: "Unauthorized" }, alternate),
        ),
      ).toMatchObject({ success: false, error: "not_found" });
      const list = await api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        ...alternate,
        paginationOpts: { numItems: 10, cursor: null },
      });
      expect(list).toMatchObject({ success: true, reports: [] });
    }
    expect(JSON.stringify(row)).toBe(before);
    expect(tables.findings).toHaveLength(1);
  });

  it("rejects stale writes and preserves a concurrent edit", async () => {
    const { api, mock, row, updateArgs } = await setup();
    const stale = updateArgs({ impact: "Stale correction" });
    await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({ impact: "Latest correction" }),
    );
    expect(
      await api.updateFindingForBackend.handler(mock.ctx, stale),
    ).toMatchObject({ success: false, error: "conflict" });
    expect(row.impact).toBe("Latest correction");
  });

  it("does not let updates replace identity, provenance, score, or lifecycle", async () => {
    const { api, mock, row, updateArgs } = await setup();
    const before = JSON.stringify(row);
    for (const changes of [
      {},
      { user_id: "other-user" },
      { chat_id: "chat-2" },
      { created_at: 1 },
      { severity: "critical" },
      { status: "active" },
      { cvss_score: 10 },
    ]) {
      expect(
        await api.updateFindingForBackend.handler(
          mock.ctx,
          updateArgs(changes),
        ),
      ).toMatchObject({ success: false, error: "validation" });
    }
    expect(JSON.stringify(row)).toBe(before);
  });

  it("preserves closure state and clears optional report fields explicitly", async () => {
    const { api, mock, row, updateArgs } = await setup();
    row.status = "closed";
    row.closure_reason = "already_fixed";
    row.closure_context = "Retest passed";
    row.closed_at = 7;
    const result = await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({ cwe: null, endpoint: null }),
    );
    expect(result).toMatchObject({ success: true });
    expect(row).toMatchObject({
      status: "closed",
      closure_context: "Retest passed",
      closed_at: 7,
    });
    expect(row.cwe).toBeUndefined();
    expect(row.endpoint).toBeUndefined();
  });

  it("keeps or replaces evidence verification with the referenced evidence", async () => {
    const { api, mock, row, updateArgs } = await setup();
    row.evidence_refs = ["/old.txt"];
    row.evidence_verification = {
      checked_refs: ["/old.txt"],
      unavailable_refs: [],
    };
    await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({ impact: "Corrected impact" }),
    );
    expect(row.evidence_verification.checked_refs).toEqual(["/old.txt"]);
    await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs(
        { evidence_refs: ["/new.txt"] },
        {
          evidenceVerification: {
            checked_refs: ["/new.txt"],
            unavailable_refs: [],
          },
        },
      ),
    );
    expect(row.evidence_verification.checked_refs).toEqual(["/new.txt"]);
    await api.updateFindingForBackend.handler(
      mock.ctx,
      updateArgs({ evidence_refs: [] }),
    );
    expect(row.evidence_refs).toEqual([]);
    expect(row.evidence_verification).toBeUndefined();
  });

  it("rejects a correction that collides with another finding", async () => {
    const { api, mock, row, updateArgs } = await setup();
    await api.createFindingForBackend.handler(
      mock.ctx,
      createArgs({ report: report({ title: "Other finding" }) }),
    );
    expect(
      await api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ title: "Other finding" }),
      ),
    ).toMatchObject({ success: false, error: "duplicate" });
    expect(row.title).toBe("Cross-tenant invoice access");
  });

  it.each(["canceled_at", "deletion_started_at"])(
    "rejects writes in a chat with %s",
    async (field) => {
      const { api, tables, mock, row, updateArgs } = await setup();
      tables.chats[0][field] = 1;
      expect(
        await api.updateFindingForBackend.handler(
          mock.ctx,
          updateArgs({ impact: "Invalid write" }),
        ),
      ).toMatchObject({ success: false, error: "chat_not_found" });
      expect(row.impact).not.toBe("Invalid write");
    },
  );

  it("caps list requests and rejects invalid service credentials", async () => {
    const { api, mock, scope, updateArgs } = await setup();
    expect(
      await api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        paginationOpts: { numItems: 100, cursor: null },
      }),
    ).toMatchObject({ success: false, error: "validation" });
    const { validateServiceKey } = await import("../lib/utils");
    (validateServiceKey as jest.Mock).mockImplementationOnce(() => {
      throw new Error("Unauthorized");
    });
    await expect(
      api.updateFindingForBackend.handler(
        mock.ctx,
        updateArgs({ title: "Unauthorized" }),
      ),
    ).rejects.toThrow("Unauthorized");
  });
});

describe("semantic finding deduplication", () => {
  beforeEach(() => jest.clearAllMocks());
  it("scopes and bounds candidates and keeps raw evidence out of comparison", async () => {
    const { createFindingForBackend, getFindingDedupeContextForBackend } =
      await import("../findings");
    const tables = seedTables();
    const { ctx, indexes } = createMockCtx(tables);
    for (let i = 0; i < 30; i++) {
      await createFindingForBackend.handler(
        ctx,
        createArgs({
          report: report({
            title: `Finding ${i}`,
            evidence: "PRIVATE_CAPTURE",
          }),
        }),
      );
      tables.findings[i].created_at = i;
    }
    await createFindingForBackend.handler(
      ctx,
      createArgs({ chatId: "chat-2", report: report({ title: "OTHER_CHAT" }) }),
    );
    const result = await getFindingDedupeContextForBackend.handler(ctx, {
      serviceKey: "service-key",
      userId: "user-1",
      chatId: "chat-1",
      dedupeKey: "absent",
    });
    expect(result.candidates).toHaveLength(25);
    expect(result.candidates[0].finding_id).toBe(
      tables.findings[29].finding_id,
    );
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE_CAPTURE|OTHER_CHAT/);
    expect(indexes).toContain("by_user_chat_created");
    await expect(
      getFindingDedupeContextForBackend.handler(ctx, {
        serviceKey: "service-key",
        userId: "other-user",
        chatId: "chat-1",
        dedupeKey: "absent",
      }),
    ).rejects.toThrow();
    const { validateServiceKey } = await import("../lib/utils");
    expect(validateServiceKey).toHaveBeenCalledWith("service-key");
  });
  it("rejects a reworded duplicate with its ID without overwriting the saved finding", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    await createFindingForBackend.handler(ctx, createArgs());
    const before = JSON.parse(JSON.stringify(tables.findings[0]));
    const result = await createFindingForBackend.handler(
      ctx,
      createArgs({
        report: report({
          title: "Billing documents accessible across accounts",
        }),
        comparisonSnapshot: [
          { finding_id: before.finding_id, updated_at: before.updated_at },
        ],
        semanticDuplicateId: before.finding_id,
      }),
    );
    expect(result).toMatchObject({
      success: false,
      error: "duplicate",
      duplicate_of: before.finding_id,
    });
    expect(tables.findings).toEqual([before]);
    expect(tables.finding_sources[0].finding_count).toBe(1);
  });
  it("rejects stale decisions after an insert, correction, or deletion", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    await createFindingForBackend.handler(ctx, createArgs());
    const finding = tables.findings[0];
    const check = (snapshot: any[]) =>
      createFindingForBackend.handler(
        ctx,
        createArgs({
          report: report({ title: "Reworded" }),
          comparisonSnapshot: snapshot,
          semanticDuplicateId: finding.finding_id,
        }),
      );
    expect(await check([])).toEqual({
      success: false,
      error: "comparison_stale",
    });
    const snapshot = [
      { finding_id: finding.finding_id, updated_at: finding.updated_at },
    ];
    finding.updated_at++;
    expect(await check(snapshot)).toEqual({
      success: false,
      error: "comparison_stale",
    });
    tables.findings.length = 0;
    expect(await check(snapshot)).toEqual({
      success: false,
      error: "comparison_stale",
    });
    expect(tables.findings).toHaveLength(0);
  });
  it("cannot reject against another chat's ID and permits distinct findings", async () => {
    const { createFindingForBackend } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    await createFindingForBackend.handler(
      ctx,
      createArgs({ chatId: "chat-2" }),
    );
    const foreignId = tables.findings[0].finding_id;
    expect(
      await createFindingForBackend.handler(
        ctx,
        createArgs({ comparisonSnapshot: [], semanticDuplicateId: foreignId }),
      ),
    ).toMatchObject({ error: "validation" });
    expect(
      await createFindingForBackend.handler(
        ctx,
        createArgs({ semanticDuplicateId: foreignId }),
      ),
    ).toMatchObject({ error: "validation" });
    expect(
      await createFindingForBackend.handler(
        ctx,
        createArgs({ comparisonSnapshot: [] }),
      ),
    ).toMatchObject({ success: true });
    expect(tables.findings).toHaveLength(2);
  });
});

describe("Agent report cursor validation", () => {
  beforeEach(() => jest.clearAllMocks());
  const scope = { serviceKey: "service", userId: "user-1", chatId: "chat-1" };
  const paginationOpts = { numItems: 1, cursor: "private-invalid-cursor" };

  it("preserves valid first-page and continuation results", async () => {
    const api = await import("../findings");
    const tables = seedTables();
    const mock = createMockCtx(tables);
    await api.createFindingForBackend.handler(mock.ctx, createArgs());
    await api.createFindingForBackend.handler(
      mock.ctx,
      createArgs({
        toolCallId: "tool-2",
        report: report({
          title: "Different invoice issue",
          target: "other.example.test",
        }),
      }),
    );
    const first = await api.listReportsForBackend.handler(mock.ctx, {
      ...scope,
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(first).toMatchObject({
      success: true,
      is_done: false,
      reports: [expect.objectContaining({ finding_id: expect.any(String) })],
    });
    const second = await api.listReportsForBackend.handler(mock.ctx, {
      ...scope,
      paginationOpts: { numItems: 1, cursor: first.next_cursor },
    });
    expect(second).toMatchObject({
      success: true,
      is_done: true,
      next_cursor: null,
      reports: [expect.objectContaining({ finding_id: expect.any(String) })],
    });
    expect(second.reports[0].finding_id).not.toBe(first.reports[0].finding_id);
  });

  it.each([undefined, "invoice"])(
    "returns actionable validation for a malformed cursor with search %s without restarting",
    async (search) => {
      const api = await import("../findings");
      const mock = createMockCtx(
        seedTables(),
        "user-1",
        new Error("Failed to parse cursor"),
      );
      const result = await api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        paginationOpts,
        search,
      });
      expect(result).toEqual({
        success: false,
        error: "validation",
        message:
          "The report cursor is invalid. Start again without a cursor and use only the next_cursor returned for the same search and status filters.",
      });
      const findingsRead = mock.ctx.db.query.mock.results.at(-1).value;
      const builder = search
        ? findingsRead.withSearchIndex
        : findingsRead.withIndex;
      const page = builder.mock.results[0].value;
      expect(page.paginate).toHaveBeenCalledTimes(1);
      expect(page.paginate).toHaveBeenCalledWith(paginationOpts);
      expect(JSON.stringify(result)).not.toContain(paginationOpts.cursor);
    },
  );

  it.each([
    new Error("Too many concurrent requests"),
    new Error("InvalidCursor: cursor used with a different query"),
    new Error("Failed to parse cursor elsewhere"),
    "Failed to parse cursor",
  ])("keeps an unrelated pagination failure visible: %s", async (failure) => {
    const api = await import("../findings");
    const mock = createMockCtx(seedTables(), "user-1", failure);
    await expect(
      api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        paginationOpts,
      }),
    ).rejects.toBe(failure);
  });

  it("keeps parser failures without a supplied cursor visible", async () => {
    const api = await import("../findings");
    const failure = new Error("Failed to parse cursor");
    const mock = createMockCtx(seedTables(), "user-1", failure);
    await expect(
      api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        paginationOpts: { numItems: 1, cursor: null },
      }),
    ).rejects.toBe(failure);
  });

  it("does not treat an authorization or history failure as cursor validation", async () => {
    const api = await import("../findings");
    const { validateServiceKey } = await import("../lib/utils");
    const { assertUserCanAccessChatHistory } =
      await import("../lib/suspensionGuards");
    const failure = new Error("Failed to parse cursor");
    for (const guard of [validateServiceKey, assertUserCanAccessChatHistory]) {
      jest.mocked(guard).mockImplementationOnce(() => {
        throw failure;
      });
      const mock = createMockCtx(seedTables(), "user-1", failure);
      await expect(
        api.listReportsForBackend.handler(mock.ctx, {
          ...scope,
          paginationOpts,
        }),
      ).rejects.toBe(failure);
      expect(mock.ctx.db.query).not.toHaveBeenCalled();
    }
  });

  it("does not inspect a foreign chat's findings even with a malformed cursor", async () => {
    const api = await import("../findings");
    const mock = createMockCtx(
      seedTables(),
      "user-1",
      new Error("Failed to parse cursor"),
    );
    await expect(
      api.listReportsForBackend.handler(mock.ctx, {
        ...scope,
        chatId: "chat-other",
        paginationOpts,
      }),
    ).resolves.toMatchObject({ success: false, error: "not_found" });
    expect(
      mock.ctx.db.query.mock.calls.map(([table]: [string]) => table),
    ).toEqual(["chats"]);
  });
});

describe("project finding membership and evidence basis", () => {
  it("persists explicit evidence basis and keeps legacy records unknown", async () => {
    const { createFindingForBackend, getFinding } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    const result = await (createFindingForBackend as any).handler(
      ctx,
      createArgs({
        report: report({
          evidence_status: "runtime_reproduced",
          evidence_status_reason:
            "Actual cross-account response observed in this run.",
        }),
      }),
    );
    expect(result.success).toBe(true);
    const saved = await (getFinding as any).handler(ctx, {
      findingId: result.finding_id,
    });
    expect(saved.evidence_status).toBe("runtime_reproduced");
    delete tables.findings[0].evidence_status;
    expect(
      (await (getFinding as any).handler(ctx, { findingId: result.finding_id }))
        .evidence_status,
    ).toBeUndefined();
  });
  it.each([
    { poc_script_code: "curl /invoice/new" },
    {
      description:
        "A revised finding claim changes the asserted authorization failure and requires reassessment.",
    },
  ])(
    "clears a previous runtime claim when changed evidence or claims are not reassessed: %j",
    async (changes) => {
      const { createFindingForBackend, updateFindingForBackend, getFinding } =
        await import("../findings");
      const tables = seedTables();
      const { ctx } = createMockCtx(tables);
      const created = await (createFindingForBackend as any).handler(
        ctx,
        createArgs({
          report: report({
            evidence_status: "runtime_reproduced",
            evidence_status_reason: "Actual cross-account response observed.",
          }),
        }),
      );
      const row = tables.findings[0];
      const result = await (updateFindingForBackend as any).handler(ctx, {
        serviceKey: "key",
        userId: "user-1",
        chatId: "chat-1",
        messageId: "message-1",
        toolCallId: "update-1",
        update: {
          finding_id: created.finding_id,
          expected_updated_at: row.updated_at,
          reason: "Different reproduction",
          changes,
        },
      });
      expect(result.success).toBe(true);
      const saved = await (getFinding as any).handler(ctx, {
        findingId: created.finding_id,
      });
      expect(saved.evidence_status).toBeUndefined();
      expect(saved.evidence_status_reason).toBeUndefined();
      expect(saved.correction_history.at(-1).changed_fields).toEqual(
        expect.arrayContaining(["evidence_status", "evidence_status_reason"]),
      );
    },
  );
  it("returns only the owned project's findings and hides stale membership during moves", async () => {
    const { createFindingForBackend, listFindings } =
      await import("../findings");
    const tables = seedTables();
    tables.projects = [
      { _id: "project-1", user_id: "user-1" },
      { _id: "foreign-project", user_id: "other-user" },
    ];
    tables.chats[0].project_id = "project-1";
    const { ctx, indexes } = createMockCtx(tables);
    await (createFindingForBackend as any).handler(ctx, createArgs());
    const args = {
      projectId: "project-1",
      paginationOpts: { cursor: null, numItems: 25 },
    };
    expect((await (listFindings as any).handler(ctx, args)).page).toHaveLength(
      1,
    );
    expect(indexes).toContain("by_user_project_created");
    tables.chats[0].project_id = undefined;
    expect((await (listFindings as any).handler(ctx, args)).page).toHaveLength(
      0,
    );
    expect(
      (
        await (listFindings as any).handler(ctx, {
          ...args,
          projectId: "foreign-project",
        })
      ).page,
    ).toHaveLength(0);
  });
  it("backfills existing reports from current chat membership and follows a later move", async () => {
    const {
      createFindingForBackend,
      backfillFindingProjects,
      syncChatFindingProject,
    } = await import("../findings");
    const tables = seedTables();
    const { ctx } = createMockCtx(tables);
    await (createFindingForBackend as any).handler(ctx, createArgs());
    tables.chats[0].project_id = "project-1";
    await (backfillFindingProjects as any).handler(ctx, { cursor: null });
    expect(tables.findings[0].project_id).toBe("project-1");
    tables.chats[0].project_id = "project-2";
    await (syncChatFindingProject as any).handler(ctx, {
      chatId: "chat-1",
      userId: "user-1",
      cursor: null,
    });
    expect(tables.findings[0].project_id).toBe("project-2");
  });
});
