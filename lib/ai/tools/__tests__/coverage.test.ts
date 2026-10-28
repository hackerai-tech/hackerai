jest.mock("@/lib/db/actions", () => ({ writeAgentCoverage: jest.fn() }));

import type { CoverageEntry } from "@/lib/ai/coverage-ledger";
import { ConvexError } from "convex/values";
import { writeAgentCoverage } from "@/lib/db/actions";
import { createCoverageWrite } from "../coverage";
import { coverageWriteInputSchema } from "../schemas";

const mockedWrite = jest.mocked(writeAgentCoverage);
const input = {
  surface: "API route",
  riskArea: "authorization",
  outcome: "needs_follow_up" as const,
  hypothesis: "A check may be missing",
  evidenceFor: "Observed behavior",
  evidenceAgainst: "One path is protected",
  missingProof: "Need a second account",
  nextTest: "Compare access",
};

const execute = async (tool: ReturnType<typeof createCoverageWrite>) =>
  (tool.execute as NonNullable<typeof tool.execute>)(input, {
    toolCallId: "call-1",
    messages: [],
    abortSignal: undefined,
  });

it("saves an unresolved row before exposing it as current coverage", async () => {
  const saved: CoverageEntry[] = [{ ...input, updatedAt: 1 }];
  mockedWrite.mockResolvedValueOnce(saved);
  let current: CoverageEntry[] = [];
  const result = await execute(
    createCoverageWrite({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      onSaved: (entries) => {
        current = entries;
      },
    }),
  );
  expect(result).toMatchObject({ success: true, total: 1 });
  expect(current).toEqual(saved);
  expect(mockedWrite).toHaveBeenCalledWith({
    userId: "user-1",
    chatId: "chat-1",
    runId: "run-1",
    entry: input,
  });
});

it("does not claim an unsaved row when persistence fails", async () => {
  mockedWrite.mockRejectedValueOnce(new Error("run inactive"));
  const onSaved = jest.fn();
  const result = await execute(
    createCoverageWrite({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      onSaved,
    }),
  );
  expect(result).toMatchObject({ success: false });
  expect(onSaved).not.toHaveBeenCalled();
});

it("returns a bounded corrective reason for a rejected coverage write", async () => {
  mockedWrite.mockRejectedValueOnce(
    new ConvexError({ code: "COVERAGE_FULL", message: "private detail" }),
  );
  const result = await execute(
    createCoverageWrite({
      userId: "user-1",
      chatId: "chat-1",
      runId: "run-1",
      onSaved: jest.fn(),
    }),
  );
  expect(result).toMatchObject({
    success: false,
    error: "Coverage is full. Update an existing surface and risk instead.",
  });
  expect(JSON.stringify(result)).not.toContain("private detail");
});

it("rejects oversized evidence before any storage call", () => {
  expect(() =>
    coverageWriteInputSchema.parse({ ...input, evidenceFor: "x".repeat(321) }),
  ).toThrow();
});
