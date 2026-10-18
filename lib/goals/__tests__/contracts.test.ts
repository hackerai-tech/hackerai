import {
  isGoalEvidencePart,
  resolveGoalOutcome,
  validGoalStart,
  verificationGatePassed,
} from "../contracts";
import { parseGoalCommand } from "../commands";

const terminal = (exitCode = 0) => ({
  type: "tool-run_terminal_cmd",
  toolCallId: "cmd",
  state: "output-available",
  input: { command: "pnpm test" },
  output: { result: { exitCode } },
});
const base = {
  runs: 1,
  maxRuns: 3,
  noProgressRuns: 0,
  allCriteriaVerified: true,
  finishReason: "stop",
  canceled: false,
  failed: false,
  usageExhausted: false,
  checkpoint: {
    outcome: "achieved" as const,
    progress: "Tests passed",
    evidence: [],
  },
  judgment: { verdict: "done" as const, reason: "Results support the outcome" },
};

describe("goal completion and limits", () => {
  it("requires evidence and an independent judgment; limits never imply success", () => {
    expect(resolveGoalOutcome(base)).toBe("achieved");
    expect(resolveGoalOutcome({ ...base, allCriteriaVerified: false })).toBe(
      "queued",
    );
    expect(resolveGoalOutcome({ ...base, judgment: undefined })).toBe("queued");
    for (const finishReason of ["step-limit", "length", "elapsed-timeout"])
      expect(resolveGoalOutcome({ ...base, finishReason })).toBe("queued");
    expect(resolveGoalOutcome({ ...base, runs: 3, judgment: undefined })).toBe(
      "budget_exhausted",
    );
    expect(resolveGoalOutcome({ ...base, canceled: true })).toBe("canceled");
    expect(resolveGoalOutcome({ ...base, usageExhausted: true })).toBe(
      "usage_exhausted",
    );
    expect(resolveGoalOutcome({ ...base, failed: true })).toBe("failed");
    expect(
      resolveGoalOutcome({
        ...base,
        judgment: { verdict: "blocked", reason: "Verifier unavailable" },
      }),
    ).toBe("blocked");
  });
  it("stops after two slices without tool progress and preserves an explicit wait", () => {
    expect(
      resolveGoalOutcome({
        ...base,
        checkpoint: undefined,
        judgment: undefined,
        noProgressRuns: 2,
      }),
    ).toBe("blocked");
    expect(
      resolveGoalOutcome({
        ...base,
        checkpoint: {
          outcome: "wait",
          progress: "Wait for the authorized job",
          evidence: [],
          waitSeconds: 60,
        },
        judgment: undefined,
      }),
    ).toBe("waiting");
  });
  it("rejects invented, failed, pending, and bookkeeping evidence", () => {
    expect(isGoalEvidencePart(terminal(), "cmd")).toBe(true);
    expect(isGoalEvidencePart(terminal(), "invented")).toBe(false);
    expect(isGoalEvidencePart(terminal(1), "cmd")).toBe(false);
    expect(
      isGoalEvidencePart({ ...terminal(), state: "input-available" }, "cmd"),
    ).toBe(false);
    expect(
      isGoalEvidencePart(
        { ...terminal(), type: "tool-goal_checkpoint" },
        "cmd",
      ),
    ).toBe(false);
  });
  it("checks the exact verification command and follows only its own terminal session", () => {
    expect(verificationGatePassed([terminal()], "pnpm test")).toBe(true);
    expect(verificationGatePassed([terminal()], "pnpm build")).toBe(false);
    expect(verificationGatePassed([terminal(1)], "pnpm test")).toBe(false);
    expect(verificationGatePassed([terminal(), terminal(1)], "pnpm test")).toBe(
      false,
    );
    expect(verificationGatePassed([terminal(1), terminal()], "pnpm test")).toBe(
      true,
    );
    const started = { ...terminal(), output: { result: { session: "s1" } } };
    const wait = {
      type: "tool-interact_with_terminal",
      toolCallId: "wait",
      state: "output-available",
      input: { session: "s1", action: "wait" },
      output: { result: { exited: { exitCode: 0 } } },
    };
    expect(verificationGatePassed([started, wait], "pnpm test")).toBe(true);
    expect(verificationGatePassed([wait, started], "pnpm test")).toBe(false);
    expect(
      verificationGatePassed(
        [
          started,
          wait,
          { ...wait, output: { result: { exited: { exitCode: 1 } } } },
        ],
        "pnpm test",
      ),
    ).toBe(false);
    expect(
      verificationGatePassed(
        [started, { ...wait, input: { session: "other", action: "wait" } }],
        "pnpm test",
      ),
    ).toBe(false);
  });
});

describe("goal commands and contract validation", () => {
  it("parses a completion contract without sending control commands as prompts", () => {
    expect(parseGoalCommand("/goal")).toEqual({ action: "status" });
    expect(parseGoalCommand("/goal pause")).toEqual({ action: "pause" });
    expect(parseGoalCommand("/goal clear")).toEqual({ action: "clear" });
    expect(parseGoalCommand("/goal resume +2 The job finished")).toEqual({
      action: "resume",
      additionalRuns: 2,
      input: "The job finished",
    });
    expect(
      parseGoalCommand(
        "/goal Fix the fixture\ncriterion: Tests pass\nverify: pnpm test\npreserve: Public API\nscope: Fixture only\nstop when: Credentials are missing\nruns: 2",
      ),
    ).toEqual({
      action: "start",
      objective: "Fix the fixture",
      criteria: ["Tests pass"],
      verificationCommand: "pnpm test",
      constraints: "Public API",
      boundaries: "Fixture only",
      stopWhen: "Credentials are missing",
      maxRuns: 2,
    });
    expect(
      parseGoalCommand(
        "/goal start Fix\n  criterion: Tests pass\n  runs: 1\n  scope: Fixture only",
      ),
    ).toEqual({
      action: "start",
      objective: "Fix",
      criteria: ["Tests pass"],
      maxRuns: 1,
      boundaries: "Fixture only",
    });
    expect(() => parseGoalCommand("/goal resume +9")).toThrow();
    expect(parseGoalCommand("a normal prompt")).toBeNull();
  });
  it("bounds the budget and contract at admission", () => {
    const input = { objective: "Fix", criteria: ["Tests pass"], maxRuns: 3 };
    expect(validGoalStart(input)).toBe(true);
    expect(validGoalStart({ ...input, maxRuns: 9 })).toBe(false);
    expect(validGoalStart({ ...input, maxRuns: 1.5 })).toBe(false);
    expect(
      validGoalStart({ ...input, verificationCommand: "x".repeat(2001) }),
    ).toBe(false);
    expect(() => parseGoalCommand("/goal Fix\nruns: 9")).toThrow();
  });
});
