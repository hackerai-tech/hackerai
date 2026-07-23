import { describe, expect, it, jest, beforeEach } from "@jest/globals";

const mockCreateFinding = jest.fn<any>();
const mockEvent = jest.fn();

jest.mock("@/lib/db/actions", () => ({ createFinding: mockCreateFinding }));
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
