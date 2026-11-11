/** @jest-environment node */
import { beforeEach, describe, expect, it, jest } from "@jest/globals";

const enabled = jest.fn<any>();
const history = jest.fn<any>();
const start = jest.fn<any>();
const complete = jest.fn<any>();
jest.mock("@/lib/findings/retest-policy", () => ({
  isFindingRetestsEnabled: (...args: unknown[]) => enabled(...args),
}));
jest.mock("@/lib/findings/agent-retest-service", () => ({
  getAgentRetestHistory: (...args: unknown[]) => history(...args),
  startAgentRetest: (...args: unknown[]) => start(...args),
  completeAgentRetest: (...args: unknown[]) => complete(...args),
}));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
// Evidence checks run the report tools' real verification; only report
// persistence, unused here, is replaced.
jest.mock("@/lib/findings/semantic-dedupe", () => ({
  createFindingWithDedupe: jest.fn(),
}));
jest.mock("@/lib/db/actions", () => ({
  listReports: jest.fn(),
  getReport: jest.fn(),
  updateFinding: jest.fn(),
}));

// Import after the mocks are registered; @jest/globals mocks are not hoisted
// above static imports.
const tools = () => import("../finding-retests");

const context = {
  userID: "user-1",
  chatId: "chat-1",
  assistantMessageId: "server-message",
  triggerRunId: "run_server",
} as any;
const options = { toolCallId: "t", messages: [] } as any;

const input = (overrides: Record<string, unknown> = {}) => ({
  finding_id: "finding-1",
  outcome: "inconclusive" as const,
  summary: "The tester session expired before the ownership check.",
  reproduction_steps: ["Request own invoice"],
  expected_result: "Own invoice loads, other account's is denied",
  observed_result: "Own invoice returned 401",
  limitations: ["Needs a fresh tester session"],
  ...overrides,
});

describe("Agent finding retest tools", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    enabled.mockResolvedValue(true);
  });

  it("fail closed when the rollout is off", async () => {
    enabled.mockResolvedValue(false);
    const { createStartFindingRetest, createCompleteFindingRetest } =
      await tools();
    expect(
      await createStartFindingRetest(context).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false, error: "unavailable" });
    expect(
      await createCompleteFindingRetest(context).execute!(input(), options),
    ).toMatchObject({ success: false, error: "unavailable" });
    expect(start).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("records provenance from the server context, never from the model", async () => {
    start.mockResolvedValue({
      success: true,
      retest_id: "r1",
      duplicate: false,
    });
    const { createStartFindingRetest } = await tools();
    const result = await createStartFindingRetest(context).execute!(
      { finding_id: "finding-1", expected_updated_at: 42 },
      options,
    );
    expect(start).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      findingId: "finding-1",
      assistantMessageId: "server-message",
      triggerRunId: "run_server",
      expectedUpdatedAt: 42,
    });
    expect(result).toMatchObject({ success: true, retest_id: "r1" });
  });

  it("refuses to record without server message provenance", async () => {
    const { createStartFindingRetest, createCompleteFindingRetest } =
      await tools();
    const withoutMessage = { ...context, assistantMessageId: undefined };
    expect(
      await createStartFindingRetest(withoutMessage).execute!(
        { finding_id: "finding-1", expected_updated_at: 1 },
        options,
      ),
    ).toMatchObject({ success: false });
    expect(
      await createCompleteFindingRetest(withoutMessage).execute!(
        input(),
        options,
      ),
    ).toMatchObject({ success: false });
    expect(start).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("rejects unredacted secrets and unsupported not-reproduced claims before saving", async () => {
    const { createCompleteFindingRetest } = await tools();
    const tool = createCompleteFindingRetest(context);
    expect(
      await tool.execute!(
        input({ observed_result: "Cookie: session=4f9a8b7c6d5e4f3a2b1c" }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(
      await tool.execute!(
        input({ outcome: "not_reproduced", limitations: [] }),
        options,
      ),
    ).toMatchObject({ success: false, error: "validation" });
    expect(complete).not.toHaveBeenCalled();
  });

  it("keeps file evidence unverified when no sandbox is connected", async () => {
    complete.mockResolvedValue({
      success: true,
      retest_id: "r1",
      duplicate: false,
    });
    const { createCompleteFindingRetest } = await tools();
    const result = await createCompleteFindingRetest(context, () => null)
      .execute!(
      input({ evidence_refs: ["/tmp/retest/own.txt", "terminal capture 3"] }),
      options,
    );
    const call = complete.mock.calls[0][0] as any;
    expect(call).toMatchObject({
      assistantMessageId: "server-message",
      triggerRunId: "run_server",
      retainedEvidenceRefs: ["terminal capture 3"],
      evidenceVerification: {
        checked_refs: [],
        unavailable_refs: ["/tmp/retest/own.txt"],
      },
    });
    expect(call.result.evidence_refs).toEqual([
      "/tmp/retest/own.txt",
      "terminal capture 3",
    ]);
    expect(call.environment).toBeUndefined();
    expect(result).toMatchObject({
      success: true,
      evidence_warning: expect.any(String),
    });
  });

  it("reads history only for reports in the current chat", async () => {
    history.mockResolvedValue({ available: false });
    const { createGetFindingRetests } = await tools();
    const result = await createGetFindingRetests(context).execute!(
      { finding_id: "finding-other" },
      options,
    );
    expect(history).toHaveBeenCalledWith({
      userId: "user-1",
      chatId: "chat-1",
      findingId: "finding-other",
      limit: 5,
    });
    expect(result).toMatchObject({ success: false, error: "not_found" });
  });
});
