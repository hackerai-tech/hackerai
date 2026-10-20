import {
  compareFindingDuplicate,
  createFindingWithDedupe,
} from "../semantic-dedupe";
import { findingComparisonSummary } from "../dedupe-context";
import { generateText } from "ai";
import { createFinding, getFindingDedupeContext } from "@/lib/db/actions";
import type { CreateVulnerabilityReportInput } from "../validation";

jest.mock("ai", () => ({
  generateText: jest.fn(),
  Output: { object: jest.fn((value) => value) },
  NoObjectGeneratedError: { isInstance: () => false },
}));
jest.mock("@/lib/ai/providers", () => ({
  myProvider: { languageModel: jest.fn(() => "model") },
  resolveAgentTierToProviderKey: () => "model",
}));
jest.mock("@/lib/api/chat-stream-helpers", () => ({
  buildProviderOptions: () => ({
    openrouter: { provider: { order: ["test"] } },
  }),
}));
jest.mock("@/lib/db/actions", () => ({
  createFinding: jest.fn(),
  getFindingDedupeContext: jest.fn(),
}));
const report = {
  title: "Invoice IDOR",
  target: "https://example.test",
  endpoint: "/invoices/:id",
  method: "GET",
  cwe: "CWE-639",
  description: "Other tenants can read invoices.",
  technical_analysis: "The invoice handler omits the tenant predicate.",
  evidence: "PRIVATE_CAPTURE",
  poc_script_code: "PRIVATE_POC",
  evidence_refs: ["PRIVATE_PATH"],
} as CreateVulnerabilityReportInput;
const candidate = {
  finding_id: "existing",
  updated_at: 1,
  summary: findingComparisonSummary({
    ...report,
    title: "Missing ownership check exposes billing documents",
  }),
};
const context = { exact_duplicate_id: null, candidates: [candidate] };
const args = {
  userId: "u",
  chatId: "c",
  messageId: "m",
  toolCallId: "t",
  report,
};
const model = jest.mocked(generateText);
const save = jest.mocked(createFinding);
const load = jest.mocked(getFindingDedupeContext);
const result = (duplicate_id: string | null, confidence = "high") =>
  ({
    output: { duplicate_id, confidence },
    usage: { raw: { cost: 0.002 } },
  }) as any;

beforeEach(() => {
  jest.resetAllMocks();
  jest.spyOn(console, "info").mockImplementation(() => {});
  load.mockResolvedValue(context);
  save.mockResolvedValue({ success: true, finding_id: "new" } as any);
});
afterEach(() => jest.restoreAllMocks());

it("skips the model for empty chats and exact matches", async () => {
  expect(
    await compareFindingDuplicate(
      report,
      { exact_duplicate_id: null, candidates: [] },
      {},
    ),
  ).toBeUndefined();
  expect(
    await compareFindingDuplicate(
      report,
      { ...context, exact_duplicate_id: "existing" },
      {},
    ),
  ).toBeUndefined();
  expect(model).not.toHaveBeenCalled();
});
it.each([
  { success: false, error: "duplicate", duplicate_of: "older-match" },
  { success: true, finding_id: "new" },
])(
  "lets the mutation recheck an older exact match atomically (%j)",
  async (outcome) => {
    load.mockResolvedValue({ ...context, exact_duplicate_id: "older-match" });
    save.mockImplementation(async (input) => {
      // A deleted or edited exact match outside the snapshot is no longer a
      // valid semantic candidate. Sending it would reject an otherwise valid save.
      if (input.semanticDuplicateId) throw new Error("invalid comparison");
      return outcome as any;
    });
    await expect(createFindingWithDedupe(args)).resolves.toEqual(outcome);
    expect(model).not.toHaveBeenCalled();
    expect(save).toHaveBeenCalledTimes(1);
  },
);
it("passes reworded root-cause summaries, accepts only a confident known ID, and accounts for cost", async () => {
  model.mockResolvedValue(result("existing"));
  const onCost = jest.fn();
  expect(await compareFindingDuplicate(report, context, { onCost })).toBe(
    "existing",
  );
  expect(onCost).toHaveBeenCalledWith(0.002);
  const call = model.mock.calls[0][0];
  expect(call.prompt).toContain("Missing ownership check");
  expect(call.prompt).toContain("Invoice IDOR");
  expect(call.prompt).not.toMatch(/PRIVATE_/);
  expect(call).toMatchObject({
    maxRetries: 0,
    timeout: 8000,
    maxOutputTokens: 2048,
    providerOptions: { openrouter: { provider: { order: ["test"] } } },
  });
  expect(JSON.stringify(jest.mocked(console.info).mock.calls)).not.toMatch(
    /Invoice|example.test|PRIVATE_|existing/,
  );
});
it.each([
  ["existing", "uncertain"],
  [null, "high"],
  ["another-chat-id", "high"],
])(
  "preserves a finding for uncertain, distinct or invalid-ID decisions (%s/%s)",
  async (id, confidence) => {
    model.mockResolvedValue(result(id, confidence!));
    await createFindingWithDedupe(args);
    expect(save).toHaveBeenCalledWith(
      expect.not.objectContaining({ semanticDuplicateId: expect.anything() }),
    );
  },
);
it.each([
  new Error("provider secret"),
  Object.assign(new Error("timeout"), { name: "TimeoutError" }),
])(
  "fails open on provider failure with exact checking retained",
  async (error) => {
    model.mockRejectedValue(error);
    await createFindingWithDedupe(args);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        comparisonSnapshot: [{ finding_id: "existing", updated_at: 1 }],
      }),
    );
    expect(JSON.stringify(jest.mocked(console.info).mock.calls)).not.toContain(
      "provider secret",
    );
  },
);
it("does not write after cancellation during the model call", async () => {
  const controller = new AbortController();
  model.mockImplementation(async () => {
    controller.abort();
    throw new Error("aborted");
  });
  await expect(
    createFindingWithDedupe(args, { abortSignal: controller.signal }),
  ).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
});
it("recompares after a concurrent write and returns its ID without a second finding", async () => {
  load
    .mockResolvedValueOnce({ exact_duplicate_id: null, candidates: [] })
    .mockResolvedValueOnce(context);
  save
    .mockResolvedValueOnce({ success: false, error: "comparison_stale" })
    .mockResolvedValueOnce({
      success: false,
      error: "duplicate",
      duplicate_of: "existing",
      message: "duplicate",
    });
  model.mockResolvedValue(result("existing"));
  expect(await createFindingWithDedupe(args)).toMatchObject({
    error: "duplicate",
    duplicate_of: "existing",
  });
  expect(save.mock.calls[1][0]).toMatchObject({
    semanticDuplicateId: "existing",
    comparisonSnapshot: [{ finding_id: "existing", updated_at: 1 }],
  });
  expect(model).toHaveBeenCalledTimes(1);
});
it("bounds retries when the comparison keeps changing", async () => {
  model.mockResolvedValue(result(null));
  save.mockResolvedValue({ success: false, error: "comparison_stale" });
  expect(await createFindingWithDedupe(args)).toMatchObject({
    error: "conflict",
    retryable: true,
  });
  expect(model).toHaveBeenCalledTimes(2);
  expect(save).toHaveBeenCalledTimes(2);
});
it("does not fall back to a write when reading the authorized context fails", async () => {
  load.mockRejectedValue(new Error("unavailable"));
  await expect(createFindingWithDedupe(args)).rejects.toThrow("unavailable");
  expect(save).not.toHaveBeenCalled();
});
it("bounds summaries and excludes captures and replacement code", () => {
  const summary = findingComparisonSummary({
    ...report,
    description: "x".repeat(10000),
    technical_analysis: "y".repeat(10000),
    code_locations: Array.from({ length: 100 }, () => ({
      file: "file.ts",
      start_line: 1,
      end_line: 2,
      fix_before: "PRIVATE_BEFORE",
      fix_after: "PRIVATE_AFTER",
    })),
  });
  expect(summary.length).toBeLessThan(4000);
  expect(summary).not.toContain("PRIVATE");
  expect(JSON.parse(summary).code_locations).toHaveLength(4);
});
