/** @jest-environment node */
jest.mock("../lib/serviceFunctions", () => ({
  mutation: (config: unknown) => config,
  query: (config: unknown) => config,
}));
import type { UIMessage } from "ai";
import type { Doc } from "../_generated/dataModel";
import { startedCommands } from "../egressAbuseReview";
import {
  compactMessageForStorage,
  estimateSerializedSizeBytes,
  pruneToolOutputs,
} from "../../lib/chat/compaction/prune-tool-outputs";
import { terminalEvidenceAfterCompaction } from "../../lib/chat/compaction/terminal-start-receipt";

// The egress review reads start receipts from saved assistant rows. These
// tests run the rolling UI prune and save-time storage compaction on inert
// fixtures, attest the result the way the Agent worker's save does, then read
// it with the review's own reader.

const COMMAND = "printf inert-fixture";
const SUMMARY = `[Terminal: ran '${COMMAND}', exit code 0]`;
const BULK = "inert-output ".repeat(3_000);

type Part = Record<string, any>;
type Provenance = Doc<"messages">["terminal_evidence_state"];

const terminalPart = (overrides: Part = {}, result: Part = {}): Part => ({
  type: "tool-run_terminal_cmd",
  toolCallId: "call_fixture_1",
  state: "output-available",
  input: { command: COMMAND, is_background: false },
  output: {
    result: {
      processStarted: true,
      pid: 4242,
      exitCode: 0,
      output: BULK,
      rawSnapshot: BULK,
      ...result,
    },
  },
  ...overrides,
});
const interactiveSend: Part = {
  type: "tool-interact_terminal_session",
  toolCallId: "call_fixture_send",
  state: "output-available",
  input: { action: "send", session: "s1", input: "inert\n" },
  output: { output: BULK },
};
const bulkText: Part = { type: "text", text: BULK };

const message = (...parts: Part[]): UIMessage => ({
  id: "msg_fixture",
  role: "assistant",
  parts: parts as UIMessage["parts"],
});

const rolling = (value: UIMessage) =>
  pruneToolOutputs([value], 0, 0).messages[0];
const severe = (value: UIMessage, softLimitBytes = 1_500) =>
  compactMessageForStorage(value, {
    softLimitBytes,
    toolOutputTokenBudget: 0,
  }).message;

/** What the worker's save records for these compacted parts. */
const attest = (before: UIMessage, after: UIMessage) =>
  terminalEvidenceAfterCompaction(before.parts, after.parts);

/** `legacy` is a row saved before terminal evidence provenance existed. */
const review = (
  value: UIMessage,
  provenance: Provenance | "legacy" = "complete",
  requireAttestation = true,
) =>
  startedCommands(
    {
      id: value.id,
      parts: value.parts,
      terminal_evidence_state: provenance === "legacy" ? undefined : provenance,
    } as unknown as Doc<"messages">,
    { requireAttestation },
  );

const STARTED = {
  messageId: "msg_fixture",
  toolCallId: "call_fixture_1",
  tool: "run_terminal_cmd",
  text: COMMAND,
  truncated: false,
};

const COMPACTIONS = [
  ["rolling prune", rolling],
  ["severe storage compaction", severe],
] as const;

describe("terminal start receipts through compaction", () => {
  it.each(COMPACTIONS)(
    "keeps the legacy summary and the start of an unchanged command after %s",
    (_name, compact) => {
      const original = message(terminalPart());
      const compacted = compact(original);
      const [part] = compacted.parts as Part[];

      // Every reader of `output` sees the same string as before receipts.
      expect(part.output).toBe(SUMMARY);
      expect(part.terminalStartReceipt).toBe(true);
      expect(JSON.stringify(part)).not.toMatch(/"pid"|"session"|inert-output/);
      expect(attest(original, compacted)).toBe("complete");
      expect(review(compacted)).toEqual({ commands: [STARTED], incomplete: 0 });
    },
  );

  it("stays within the storage limit and is stable across repeated compaction", () => {
    const original = message(
      terminalPart(),
      terminalPart({ toolCallId: "call_fixture_2" }),
    );
    const once = severe(original);
    expect(estimateSerializedSizeBytes(once.parts)).toBeLessThanOrEqual(1_500);

    const again = severe(rolling(severe(once)));
    expect(again.parts).toEqual(once.parts);
    expect(attest(original, again)).toBe("complete");
    expect(review(again).commands).toHaveLength(2);
    expect(review(again).incomplete).toBe(0);
  });

  it("is complete when only other parts are trimmed", () => {
    const original = message(bulkText, terminalPart());
    const compacted = severe(original, 600);

    expect(compacted.parts).toHaveLength(1);
    expect(estimateSerializedSizeBytes(compacted.parts)).toBeLessThanOrEqual(
      600,
    );
    expect(attest(original, compacted)).toBe("complete");
    expect(review(compacted)).toEqual({ commands: [STARTED], incomplete: 0 });
  });

  it.each([
    ["a started command", terminalPart()],
    ["an interactive send", interactiveSend],
  ])("records a gap when the hard limit drops %s", (_label, dropped) => {
    const original = message(dropped, bulkText);
    const compacted = severe(original, 2_000);

    expect(compacted.parts).toEqual([
      expect.objectContaining({ type: "text" }),
    ]);
    expect(estimateSerializedSizeBytes(compacted.parts)).toBeLessThanOrEqual(
      2_000,
    );
    expect(attest(original, compacted)).toBe("incomplete");
    // Nothing of the dropped call remains; only the state shows the gap.
    expect(review(compacted, "incomplete")).toEqual({
      commands: [],
      incomplete: 1,
    });
  });

  it("drops the receipt and records a gap when storage clips the command", () => {
    const longCommand = `printf '${"x".repeat(1_200)}'`;
    const original = message(terminalPart({ input: { command: longCommand } }));
    const compacted = severe(original, 900);
    const [part] = compacted.parts as Part[];

    expect(part.input.command).toContain("[truncated for storage]");
    expect(part.output).toEqual(expect.stringMatching(/^\[Terminal: ran /));
    expect(part).not.toHaveProperty("terminalStartReceipt");
    expect(attest(original, compacted)).toBe("incomplete");
    expect(review(compacted, "incomplete")).toEqual({
      commands: [],
      incomplete: 2,
    });
  });

  it("drops the receipt when the input is replaced by the minimal part", () => {
    const original = message(
      terminalPart({ input: { command: `printf '${"z".repeat(1_200)}'` } }),
    );
    const compacted = severe(original, 260);
    const [part] = compacted.parts as Part[];

    expect(part.input).toEqual({ __hackeraiStorageTruncated: true });
    expect(part).not.toHaveProperty("terminalStartReceipt");
    expect(attest(original, compacted)).toBe("incomplete");
  });

  it("records a gap when storage clips an interactive send", () => {
    const original = message({
      ...interactiveSend,
      input: { action: "send", session: "s1", input: "x".repeat(2_000) },
    });
    const compacted = severe(original, 260);

    expect((compacted.parts[0] as Part).input).not.toHaveProperty("action");
    expect(attest(original, compacted)).toBe("incomplete");
  });

  it("drops an earlier receipt once a later stage clips the command", () => {
    const longCommand = `printf '${"y".repeat(1_200)}'`;
    const original = message(terminalPart({ input: { command: longCommand } }));
    const rolled = rolling(original);
    expect(review(rolled).commands).toHaveLength(1);

    const compacted = severe(rolled, 900);
    expect(compacted.parts[0]).not.toHaveProperty("terminalStartReceipt");
    expect(attest(original, compacted)).toBe("incomplete");
  });

  it("accepts the receipt only on worker-attested rows", () => {
    const compacted = rolling(message(terminalPart()));

    // Older rows and the advisory read never trust a receipt they did not
    // attest; the summary text alone is not a start.
    expect(review(compacted, "legacy", false)).toEqual({
      commands: [],
      incomplete: 1,
    });
    expect(review(compacted, "legacy", true)).toEqual({
      commands: [],
      incomplete: 2,
    });
    for (const requireAttestation of [true, false])
      expect(review(compacted, "unverified", requireAttestation)).toEqual({
        commands: [],
        incomplete: 1,
      });
    // A worker save that lost other terminal evidence still shows this call.
    expect(review(compacted, "incomplete")).toEqual({
      commands: [STARTED],
      incomplete: 1,
    });
  });

  it("keeps structured receipts of older rows for the advisory read only", () => {
    const legacy = message(terminalPart());

    expect(review(legacy, "legacy", false)).toEqual({
      commands: [STARTED],
      incomplete: 0,
    });
    expect(review(legacy, "legacy", true)).toEqual({
      commands: [STARTED],
      incomplete: 1,
    });
  });

  const ineligible: Array<[string, Part]> = [
    ["a denied approval", terminalPart({}, { approvalDenied: true })],
    [
      "a result without start state",
      terminalPart({}, { processStarted: undefined, pid: undefined }),
    ],
    ["a legacy plain summary", terminalPart({ output: `${SUMMARY} ${BULK}` })],
    ["an errored call", terminalPart({ state: "output-error" })],
    [
      "a non-exec action",
      terminalPart({ input: { command: COMMAND, action: "kill" } }),
    ],
    ["a blank command", terminalPart({ input: { command: "  " } })],
    [
      "an already compacted input",
      terminalPart({ input: { __hackeraiStorageTruncated: true } }),
    ],
  ];

  it.each(
    ineligible.flatMap(([label, part]) =>
      COMPACTIONS.map(
        ([name, compact]) => [label, name, part, compact] as const,
      ),
    ),
  )(
    "never creates a receipt for %s after %s",
    (_label, _name, part, compact) => {
      const original = message(part);
      const compacted = compact(original);

      expect(compacted.parts[0]).not.toHaveProperty("terminalStartReceipt");
      expect(review(compacted)).toEqual(review(original));
      expect(review(compacted).commands).toEqual([]);
      expect(attest(original, compacted)).toBe("complete");
    },
  );

  it.each([
    ["an errored call", { state: "output-error" }],
    ["a non-exec action", { input: { command: COMMAND, action: "kill" } }],
    ["a malformed receipt", { terminalStartReceipt: "yes" }],
  ])("removes a receipt left on %s", (_label, overrides) => {
    const original = message({
      ...terminalPart(),
      output: SUMMARY,
      terminalStartReceipt: true,
      ...overrides,
    });
    const compacted = severe(message(bulkText, ...original.parts), 1_200);

    expect(compacted.parts.at(-1)).not.toHaveProperty("terminalStartReceipt");
    expect(review(compacted).commands).toEqual([]);
  });
});
