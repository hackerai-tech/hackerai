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
import { sanitizeTerminalPartForShare } from "../../lib/chat/shared-terminal-sanitizer";

// The egress review reads start receipts from saved assistant rows. These
// tests run the rolling UI prune and save-time storage compaction on inert
// fixtures, then read the result with the review's own reader.

const COMMAND = "printf inert-fixture";
const SUMMARY = `[Terminal: ran '${COMMAND}', exit code 0]`;
const BULK = "inert-output ".repeat(3_000);

type Part = Record<string, any>;

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

const review = (value: UIMessage) =>
  startedCommands({
    id: value.id,
    parts: value.parts,
  } as unknown as Doc<"messages">);

const COMPACTIONS = [
  ["rolling prune", rolling],
  ["severe storage compaction", severe],
] as const;

describe("terminal start receipts through compaction", () => {
  it("reads the uncompacted fixture as one started command", () => {
    expect(review(message(terminalPart()))).toEqual({
      commands: [expect.objectContaining({ text: COMMAND, truncated: false })],
      incomplete: 0,
    });
  });

  it.each(COMPACTIONS)(
    "keeps the start state and the unchanged command after %s",
    (_name, compact) => {
      const compacted = compact(message(terminalPart()));
      const [part] = compacted.parts as Part[];

      expect(review(compacted)).toEqual({
        commands: [
          {
            messageId: "msg_fixture",
            toolCallId: "call_fixture_1",
            tool: "run_terminal_cmd",
            text: COMMAND,
            truncated: false,
          },
        ],
        incomplete: 0,
      });
      // Only the existing summary and start state remain: no PID, session,
      // exit code, raw output or snapshot.
      expect(part.output).toEqual({
        result: { output: SUMMARY, processStarted: true },
        __hackeraiStorageCompacted: true,
      });
      expect(part.input).toEqual({ command: COMMAND, is_background: false });
    },
  );

  it("stays within the storage limit and is stable across repeated compaction", () => {
    const once = severe(
      message(terminalPart(), terminalPart({ toolCallId: "call_fixture_2" })),
    );
    expect(estimateSerializedSizeBytes(once.parts)).toBeLessThanOrEqual(1_500);

    const again = severe(rolling(severe(once)));
    expect(again.parts).toEqual(once.parts);
    expect(review(again).commands).toHaveLength(2);
    expect(review(again).incomplete).toBe(0);
  });

  it("drops the receipt when storage compaction clips the command", () => {
    const longCommand = `printf '${"x".repeat(600)}'`;
    const compacted = severe(
      message(terminalPart({ input: { command: longCommand } })),
      900,
    );
    const [part] = compacted.parts as Part[];

    expect(part.input.command).toContain("[truncated for storage]");
    expect(part.output).toEqual(expect.stringMatching(/^\[Terminal: ran /));
    expect(review(compacted)).toEqual({ commands: [], incomplete: 1 });
  });

  it("drops the receipt when the input is replaced by the minimal part", () => {
    const compacted = severe(message(terminalPart()), 260);
    const [part] = compacted.parts as Part[];

    expect(part.input).toEqual({ __hackeraiStorageTruncated: true });
    expect(JSON.stringify(part.output ?? null)).not.toMatch(
      /processStarted|"pid"|"session"/,
    );
    expect(review(compacted)).toEqual({ commands: [], incomplete: 1 });
  });

  it("drops an earlier compact receipt once a later stage clips the command", () => {
    const longCommand = `printf '${"y".repeat(600)}'`;
    const rolled = rolling(
      message(terminalPart({ input: { command: longCommand } })),
    );
    expect(review(rolled).commands).toHaveLength(1);

    const compacted = severe(rolled, 900);
    expect((compacted.parts[0] as Part).input.command).toContain(
      "[truncated for storage]",
    );
    expect(review(compacted)).toEqual({ commands: [], incomplete: 1 });
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
      const before = review(message(part));
      const compacted = compact(message(part));

      expect(review(compacted).commands).toEqual([]);
      expect(review(compacted).incomplete).toBe(before.incomplete);
      expect(JSON.stringify(compacted.parts)).not.toContain(
        '"processStarted":true',
      );
    },
  );

  it("keeps the share sanitizer's safe summary and the receipt shape", () => {
    const [part] = rolling(message(terminalPart())).parts as Part[];

    expect(sanitizeTerminalPartForShare(part)).toEqual(part);

    const withPath = rolling(
      message(terminalPart({}, { recordPath: "/tmp/fixture/record.json" })),
    ).parts[0] as Part;
    expect(withPath.output.result.output).toContain("/tmp/fixture");
    expect(sanitizeTerminalPartForShare(withPath).output).toEqual({
      result: {
        output: "[Terminal: prior output compacted for storage]",
        processStarted: true,
      },
      __hackeraiStorageCompacted: true,
    });
  });
});
