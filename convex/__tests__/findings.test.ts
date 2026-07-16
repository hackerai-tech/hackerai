import { beforeEach, describe, expect, it, jest } from "@jest/globals";

jest.mock("../_generated/server", () => ({
  mutation: jest.fn((config: any) => config),
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
});

function createResult(rows: Row[], filters: Array<[string, unknown]>) {
  const filtered = () =>
    rows.filter((row) =>
      filters.every(([field, value]) => row[field] === value),
    );
  const result: any = {
    first: jest.fn(async () => filtered()[0] ?? null),
    collect: jest.fn(async () => filtered()),
    take: jest.fn(async (limit: number) => filtered().slice(0, limit)),
    order: jest.fn((direction: "asc" | "desc") => {
      rows = [...filtered()].sort((a, b) =>
        direction === "desc"
          ? (b.created_at ?? 0) - (a.created_at ?? 0)
          : (a.created_at ?? 0) - (b.created_at ?? 0),
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
  };
  return result;
}

function createMockCtx(tables: Tables, subject = "user-1") {
  let nextId = 1;
  const query = jest.fn((table: string) => ({
    withIndex: jest.fn((_index: string, build: (q: any) => any) => {
      const filters: Array<[string, unknown]> = [];
      const q: any = {
        eq: (field: string, value: unknown) => {
          filters.push([field, value]);
          return q;
        },
      };
      build(q);
      return createResult(tables[table] ?? [], filters);
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
      return createResult(rows, filters);
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
      db: { query, insert, patch, delete: deleteDoc },
    } as any,
    insert,
    patch,
    deleteDoc,
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
        cvss_score: 6.5,
        cvss_vector: "CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N",
        dedupe_key: expect.any(String),
        search_text: expect.stringContaining("CWE-639"),
        created_at: expect.any(Number),
        updated_at: expect.any(Number),
      }),
    );
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

    expect(duplicate).toMatchObject({ success: false, error: "duplicate" });
    expect(crossChat).toMatchObject({ success: true });
    expect(tables.findings).toHaveLength(2);
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
        severity: "critical",
        cvss_score: 10,
        search_text: "Other private finding",
        created_at: 30,
      },
    ];
    const { ctx } = createMockCtx(tables);

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

    const searched = await listFindings.handler(ctx, {
      paginationOpts: { cursor: null, numItems: 10 },
      search: "CWE-639",
    });
    expect(searched.page.map((item: any) => item.finding_id)).toEqual(["new"]);
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
});
