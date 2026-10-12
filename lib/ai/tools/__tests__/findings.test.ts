import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockCreateFinding = jest.fn<any>();
const mockListReports = jest.fn<any>();
const mockGetReport = jest.fn<any>();
const mockUpdateFinding = jest.fn<any>();
const mockEvent = jest.fn();

jest.mock("@/lib/db/actions", () => ({
  createFinding: mockCreateFinding,
  listReports: mockListReports,
  getReport: mockGetReport,
  updateFinding: mockUpdateFinding,
}));
jest.mock("@/lib/posthog/server", () => ({
  phLogger: { event: mockEvent },
}));

const input = {
  title: "Confirmed IDOR",
  description: "Another account's invoice is readable.",
  impact: "Billing data disclosure.",
  target: "app.example.test",
  technical_analysis: "The handler omits an owner predicate.",
  poc_description: "Request another account's invoice.",
  poc_script_code: "curl /api/invoices/other",
  remediation_steps: "Add an owner predicate.",
  evidence: "HTTP 200 returned the other account's data.",
  assumptions: "Ordinary authenticated account.",
  fix_effort: "low" as const,
  cvss_breakdown: {
    attack_vector: "N" as const,
    attack_complexity: "L" as const,
    privileges_required: "L" as const,
    user_interaction: "N" as const,
    scope: "U" as const,
    confidentiality: "H" as const,
    integrity: "N" as const,
    availability: "N" as const,
  },
};

describe("create_vulnerability_report execution", () => {
  beforeEach(() => jest.clearAllMocks());

  it("returns compact persistence data and emits content-free creation analytics", async () => {
    const compact = {
      success: true,
      finding_id: "finding-1",
      title: input.title,
      target: input.target,
      severity: "high",
      cvss_score: 7.1,
    };
    mockCreateFinding.mockResolvedValue(compact);
    const { createCreateVulnerabilityReport } = await import("../findings");
    const tool = createCreateVulnerabilityReport({
      userID: "user-1",
      chatId: "chat-1",
      assistantMessageId: "message-1",
    } as any) as any;

    await expect(
      tool.execute(input, { toolCallId: "tool-1" }),
    ).resolves.toEqual(compact);
    expect(mockCreateFinding).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      messageId: "message-1",
      toolCallId: "tool-1",
      report: input,
    });
    expect(mockEvent).toHaveBeenCalledWith("finding_created", {
      userId: "user-1",
    });
    expect(JSON.stringify(mockEvent.mock.calls)).not.toMatch(
      /Confirmed IDOR|app\.example|HTTP 200|curl/,
    );
  });

  it("reports deterministic duplicate rejection without retrying", async () => {
    mockCreateFinding.mockResolvedValue({
      success: false,
      error: "duplicate",
      message: "A matching finding already exists in this chat.",
    });
    const { createCreateVulnerabilityReport } = await import("../findings");
    const tool = createCreateVulnerabilityReport({
      userID: "user-1",
      chatId: "chat-1",
      assistantMessageId: "message-1",
    } as any) as any;

    await expect(
      tool.execute(input, { toolCallId: "tool-2" }),
    ).resolves.toMatchObject({ success: false, error: "duplicate" });
    expect(mockCreateFinding).toHaveBeenCalledTimes(1);
    expect(mockEvent).toHaveBeenCalledWith("finding_duplicate_rejected", {
      userId: "user-1",
    });
  });

  it("does not persist without assistant-message provenance", async () => {
    const { createCreateVulnerabilityReport } = await import("../findings");
    const tool = createCreateVulnerabilityReport({
      userID: "user-1",
      chatId: "chat-1",
    } as any) as any;

    await expect(
      tool.execute(input, { toolCallId: "tool-3" }),
    ).resolves.toMatchObject({
      success: false,
      error: "general",
      retryable: false,
    });
    expect(mockCreateFinding).not.toHaveBeenCalled();
  });

  it("marks an unexpected persistence failure for one model-managed retry", async () => {
    mockCreateFinding.mockRejectedValue(new Error("temporary outage"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const { createCreateVulnerabilityReport } = await import("../findings");
    const tool = createCreateVulnerabilityReport({
      userID: "user-1",
      chatId: "chat-1",
      assistantMessageId: "message-1",
    } as any) as any;

    await expect(
      tool.execute(input, { toolCallId: "tool-4" }),
    ).resolves.toMatchObject({
      success: false,
      error: "general",
      retryable: true,
      message: expect.stringContaining("Retry the same report once"),
    });
    expect(mockCreateFinding).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });
});

describe("report evidence integration", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateFinding.mockResolvedValue({
      success: true,
      finding_id: "finding-1",
    });
  });
  const context = {
    userID: "user-1",
    chatId: "chat-1",
    assistantMessageId: "message-1",
  } as any;
  const evidenceInput = {
    ...input,
    evidence_refs: ["/tmp/control.http", "/tmp/exploit.http"],
  };
  const sandboxWith = (states: string[]) =>
    ({
      sandboxKind: "e2b",
      sandboxId: "owned",
      commands: {
        run: jest
          .fn<any>()
          .mockResolvedValue({ stdout: JSON.stringify(states), exitCode: 0 }),
      },
    }) as any;
  it("checks existing references once and persists server-owned metadata", async () => {
    const { createCreateVulnerabilityReport } = await import("../findings");
    const sandbox = sandboxWith(["exists", "exists"]);
    const tool = createCreateVulnerabilityReport(context, () => sandbox) as any;
    expect(
      await tool.execute(evidenceInput, { toolCallId: "tool-1" }),
    ).toMatchObject({ success: true });
    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(mockCreateFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        report: evidenceInput,
        evidenceVerification: {
          checked_refs: evidenceInput.evidence_refs,
          unavailable_refs: [],
        },
      }),
    );
  });
  it.each(["missing", "forbidden"])(
    "does not persist %s references",
    async (state) => {
      const { createCreateVulnerabilityReport } = await import("../findings");
      const sandbox = sandboxWith(["exists", state]);
      const tool = createCreateVulnerabilityReport(
        context,
        () => sandbox,
      ) as any;
      expect(
        await tool.execute(evidenceInput, { toolCallId: "tool-1" }),
      ).toMatchObject({
        success: false,
        error: "validation",
        validation_kind: "evidence",
        retryable: false,
      });
      expect(mockCreateFinding).not.toHaveBeenCalled();
    },
  );
  it("preserves unavailable references only in warning metadata without starting a sandbox", async () => {
    const { createCreateVulnerabilityReport } = await import("../findings");
    const tool = createCreateVulnerabilityReport(context) as any;
    await tool.execute(evidenceInput, { toolCallId: "tool-1" });
    expect(mockCreateFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        report: { ...evidenceInput, evidence_refs: [] },
        evidenceVerification: {
          checked_refs: [],
          unavailable_refs: evidenceInput.evidence_refs,
          warning: expect.any(String),
        },
      }),
    );
  });
  it("never saves a report after cancellation", async () => {
    const { createCreateVulnerabilityReport } = await import("../findings");
    const controller = new AbortController();
    controller.abort();
    const tool = createCreateVulnerabilityReport(context) as any;
    await expect(
      tool.execute(evidenceInput, {
        toolCallId: "tool-1",
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(mockCreateFinding).not.toHaveBeenCalled();
  });
});

describe("Agent report read/update tools", () => {
  const context = {
    userID: "user-1",
    chatId: "chat-1",
    assistantMessageId: "update-message",
  } as any;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetReport.mockResolvedValue({
      success: true,
      report: { finding_id: "finding-1", updated_at: 10, ...input },
    });
    mockUpdateFinding.mockResolvedValue({
      success: true,
      finding_id: "finding-1",
      title: input.title,
    });
  });
  it("uses trusted scope for listing and reading, and returns full proof only to the read call", async () => {
    const { createListReports, createGetReport } = await import("../findings");
    mockListReports.mockResolvedValue({
      success: true,
      reports: [],
      is_done: true,
      next_cursor: null,
    });
    await (createListReports(context) as any).execute(
      { limit: 10 },
      { toolCallId: "list-1" },
    );
    expect(mockListReports).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      limit: 10,
      cursor: null,
      search: undefined,
      status: undefined,
    });
    const read = createGetReport(context) as any;
    const output = await read.execute(
      { finding_id: "finding-1" },
      { toolCallId: "read-1" },
    );
    expect(mockGetReport).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      findingId: "finding-1",
    });
    expect(
      JSON.parse(read.toModelOutput({ output }).value).report.evidence,
    ).toBe(input.evidence);
  });
  it("updates once with trusted provenance and content-free analytics", async () => {
    const { createUpdateVulnerabilityReport } = await import("../findings");
    const update = {
      finding_id: "finding-1",
      expected_updated_at: 10,
      reason: "Correct assessment",
      changes: { impact: "Limited disclosure" },
    };
    await (createUpdateVulnerabilityReport(context) as any).execute(update, {
      toolCallId: "update-1",
    });
    expect(mockUpdateFinding).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      messageId: "update-message",
      toolCallId: "update-1",
      update,
    });
    expect(mockEvent).toHaveBeenCalledWith("finding_updated", {
      userId: "user-1",
    });
    expect(JSON.stringify(mockEvent.mock.calls)).not.toMatch(
      /disclosure|assessment|finding-1/,
    );
  });
  it.each(["not_found", "conflict"])(
    "does not write after %s",
    async (error) => {
      const { createUpdateVulnerabilityReport } = await import("../findings");
      mockGetReport.mockResolvedValue(
        error === "not_found"
          ? { success: false, error }
          : { success: true, report: { updated_at: 11 } },
      );
      const result = await (
        createUpdateVulnerabilityReport(context) as any
      ).execute(
        {
          finding_id: "finding-1",
          expected_updated_at: 10,
          reason: "Correct",
          changes: { evidence_refs: ["/private.txt"] },
        },
        { toolCallId: "update-1" },
      );
      expect(result).toMatchObject({ success: false, error });
      expect(mockUpdateFinding).not.toHaveBeenCalled();
    },
  );
  it("preserves the update with a warning when no sandbox is connected", async () => {
    const { createUpdateVulnerabilityReport } = await import("../findings");
    await (createUpdateVulnerabilityReport(context) as any).execute(
      {
        finding_id: "finding-1",
        expected_updated_at: 10,
        reason: "Correct",
        changes: { evidence_refs: ["/capture.txt"] },
      },
      { toolCallId: "update-1" },
    );
    expect(mockUpdateFinding).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ changes: { evidence_refs: [] } }),
        evidenceVerification: expect.objectContaining({
          unavailable_refs: ["/capture.txt"],
          warning: expect.any(String),
        }),
      }),
    );
  });
  it.each(["missing", "forbidden"])(
    "rejects changed %s captures without altering the existing report",
    async (state) => {
      const { createUpdateVulnerabilityReport } = await import("../findings");
      const sandbox = {
        sandboxKind: "e2b",
        sandboxId: "owned",
        commands: {
          run: jest.fn<any>().mockResolvedValue({
            stdout: JSON.stringify([state]),
            exitCode: 0,
          }),
        },
      } as any;
      const result = await (
        createUpdateVulnerabilityReport(context, () => sandbox) as any
      ).execute(
        {
          finding_id: "finding-1",
          expected_updated_at: 10,
          reason: "Improved proof",
          changes: { evidence_refs: ["/capture.txt"] },
        },
        { toolCallId: "update-1" },
      );
      expect(result).toMatchObject({
        success: false,
        error: "validation",
        validation_kind: "evidence",
        retryable: false,
      });
      expect(mockUpdateFinding).not.toHaveBeenCalled();
      expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    },
  );
  it("does not inspect captures when only report prose changes", async () => {
    const { createUpdateVulnerabilityReport } = await import("../findings");
    const getSandbox = jest.fn(() => {
      throw new Error("Must not acquire a sandbox");
    });
    await (createUpdateVulnerabilityReport(context, getSandbox) as any).execute(
      {
        finding_id: "finding-1",
        expected_updated_at: 10,
        reason: "Correct impact",
        changes: { impact: "Limited impact" },
      },
      { toolCallId: "update-1" },
    );
    expect(getSandbox).not.toHaveBeenCalled();
    expect(mockUpdateFinding).toHaveBeenCalledTimes(1);
  });
  it("asks for reconciliation rather than blind retry after an uncertain write", async () => {
    const { createUpdateVulnerabilityReport } = await import("../findings");
    mockUpdateFinding.mockRejectedValueOnce(new Error("Lost response"));
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    const result = await (
      createUpdateVulnerabilityReport(context) as any
    ).execute(
      {
        finding_id: "finding-1",
        expected_updated_at: 10,
        reason: "Correct",
        changes: { impact: "Updated" },
      },
      { toolCallId: "update-1" },
    );
    expect(result).toMatchObject({
      success: false,
      retryable: false,
      message: expect.stringContaining("Read the report again"),
    });
    errorSpy.mockRestore();
  });
  it("does not write when aborted or provenance is missing", async () => {
    const { createUpdateVulnerabilityReport } = await import("../findings");
    const update = {
      finding_id: "finding-1",
      expected_updated_at: 10,
      reason: "Correct",
      changes: { impact: "Updated" },
    };
    await expect(
      (createUpdateVulnerabilityReport(context) as any).execute(update, {
        toolCallId: "update-1",
        abortSignal: AbortSignal.abort(),
      }),
    ).rejects.toBeDefined();
    expect(
      await (
        createUpdateVulnerabilityReport({
          ...context,
          assistantMessageId: undefined,
        }) as any
      ).execute(update, { toolCallId: "update-2" }),
    ).toMatchObject({ success: false, retryable: false });
    expect(mockUpdateFinding).not.toHaveBeenCalled();
  });
});
