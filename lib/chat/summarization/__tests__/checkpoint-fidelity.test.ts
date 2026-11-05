import type { ModelMessage } from "ai";
import { deserialize, serialize } from "node:v8";
import { convertToModelMessages } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import {
  boundModelMessagesForSummarization,
  buildSummaryMessage,
  estimateSummaryInputTokens,
  generateSummaryText,
} from "../helpers";

jest.mock("@/lib/db/actions", () => ({}));

const originalClone = globalThis.structuredClone;
beforeAll(() => {
  globalThis.structuredClone = <T>(value: T): T =>
    deserialize(serialize(value));
});
afterAll(() => {
  globalThis.structuredClone = originalClone;
});

const checkpoint = (): ModelMessage => ({
  role: "user",
  content:
    "<context_summary>\nScope: offline fixture only.\n" +
    "Earlier checked file. ".repeat(400) +
    "\nCandidate A: REJECTED. The permissive harness result is invalid for the restricted harness. Evidence: /tmp/fixture/restricted.json.\n" +
    "Candidate B: INCONCLUSIVE, awaiting a restricted-harness test.\n" +
    "Earlier checked file. ".repeat(400) +
    "\nNext: inspect the existing restricted-harness result; do not rerun completed tests.\n</context_summary>",
});

const recentTransaction = (cycle: number): ModelMessage[] => [
  {
    role: "assistant",
    content: [
      {
        type: "reasoning",
        text: "Consider alternatives. ".repeat(22_000),
      },
      {
        type: "tool-call",
        toolCallId: `check-${cycle}`,
        toolName: "read_file",
        input: { path: "/tmp/fixture/restricted.json" },
      },
    ],
  },
  {
    role: "tool",
    content: [
      {
        type: "tool-result",
        toolCallId: `check-${cycle}`,
        toolName: "read_file",
        output: {
          type: "text",
          value: `Artifact inspection: Check ${cycle} completed. No new candidate result.`,
        },
      },
    ],
  },
];

describe("checkpoint fidelity under summary input pressure", () => {
  it("preserves a fitting prior checkpoint and newer evidence under overflow", () => {
    const prior = checkpoint();
    const messages = [prior, ...recentTransaction(1)];
    const original = JSON.stringify(messages);
    expect(estimateSummaryInputTokens(messages)).toBeGreaterThan(64_000);

    const bounded = boundModelMessagesForSummarization(messages);

    expect(JSON.stringify(bounded[0]) === JSON.stringify(prior)).toBe(true);
    expect(JSON.stringify(bounded)).toContain("Check 1 completed");
    expect(estimateSummaryInputTokens(bounded)).toBeLessThanOrEqual(64_000);
    expect(JSON.stringify(messages)).toBe(original);
  });

  it("bounds the encoded fallback, including escaped provider metadata", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: "Recent observation",
        providerOptions: {
          fixture: { opaque: '\\"\n'.repeat(30_000) },
        },
      },
    ];
    const bounded = boundModelMessagesForSummarization(messages, {
      maxInputTokens: 1024,
    });
    expect(bounded.length).toBeGreaterThan(0);
    expect(JSON.stringify(bounded)).toContain("Recent observation");
    expect(estimateSummaryInputTokens(bounded)).toBeLessThanOrEqual(1024);
  });

  it("does not call the provider if the budget cannot retain source history", async () => {
    const model = new MockLanguageModelV3();
    await expect(
      generateSummaryText(
        [],
        model,
        "agent",
        "Summarize.",
        false,
        undefined,
        undefined,
        undefined,
        recentTransaction(1),
        1,
      ),
    ).rejects.toThrow("cannot retain any source history");
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("does not replay signatures for reasoning shortened in the summary copy", () => {
    const messages = recentTransaction(1);
    messages[0].providerOptions = {
      openrouter: {
        reasoning_details: [
          { signature: "stale-signature", text: "opaque ".repeat(40_000) },
        ],
      },
    };
    const bounded = boundModelMessagesForSummarization(messages);
    const serialized = JSON.stringify(bounded);
    expect(serialized).not.toContain("stale-signature");
    expect(serialized).toContain("not confirmed evidence");
    expect(serialized).toContain('"toolCallId":"check-1"');
    expect(messages[0].providerOptions).toBeDefined();
  });

  it.each([512, 1024, 4096])(
    "caps oversized checkpoints and encoded fallback together at %i",
    (maxInputTokens) => {
      const messages: ModelMessage[] = [
        checkpoint(),
        {
          role: "assistant",
          content: "New evidence: the old harness is no longer active.",
          providerOptions: { fixture: { opaque: '\\"\n'.repeat(30_000) } },
        },
      ];
      const bounded = boundModelMessagesForSummarization(messages, {
        maxInputTokens,
      });
      expect(estimateSummaryInputTokens(bounded)).toBeLessThanOrEqual(
        maxInputTokens,
      );
      expect(JSON.stringify(bounded)).toContain("New evidence");
    },
  );

  it("preserves supplied state through four forced SDK compactions and JSON reloads", async () => {
    // This provider double checks fidelity of the *input*, not model semantics.
    // It can carry a correction forward only if the real projection supplies it.
    const initial = (checkpoint().content as string).replace(
      "Candidate A: REJECTED. The permissive harness result is invalid for the restricted harness.",
      "Candidate A: initially reported working in the permissive harness.",
    );
    let history: ModelMessage[] = [{ role: "user", content: initial }];
    let cycle = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async ({ prompt }) => {
        const serialized = JSON.stringify(prompt);
        expect(serialized).toContain("Scope: offline fixture only");
        expect(serialized).toContain("Candidate B: INCONCLUSIVE");
        expect(serialized).toContain("/tmp/fixture/restricted.json");
        expect(serialized).toContain(`Check ${cycle} completed`);
        if (cycle === 1) {
          expect(serialized).toContain("initially reported working");
          expect(serialized).toContain("Correction: candidate A rejected");
        } else {
          expect(serialized).toContain("Candidate A: REJECTED");
          expect(serialized).not.toContain("initially reported working");
        }
        // Simulate a summary that faithfully carries the supplied correction.
        const text = (checkpoint().content as string)
          .replace("<context_summary>\n", "")
          .replace("\n</context_summary>", "");
        return {
          content: [{ type: "text", text }],
          finishReason: { unified: "stop", raw: "stop" },
          usage: {
            inputTokens: {
              total: 1,
              noCache: 1,
              cacheRead: undefined,
              cacheWrite: undefined,
            },
            outputTokens: { total: 1, text: 1, reasoning: undefined },
          },
          warnings: [],
        };
      },
    });
    for (cycle = 1; cycle <= 4; cycle++) {
      history.push(...recentTransaction(cycle));
      if (cycle === 1) {
        history.push({
          role: "user",
          content:
            "Correction: candidate A rejected. The permissive harness is not representative of the restricted harness. Candidate B remains inconclusive.",
        });
      }
      const result = await generateSummaryText(
        [],
        model,
        "agent",
        "Summarize the supplied fixture.",
        true,
        undefined,
        undefined,
        undefined,
        history,
      );
      expect(result.usage.estimatedCompactedInputTokens).toBeLessThanOrEqual(
        64_000,
      );
      // Exercise the actual UI checkpoint format and SDK reconstruction used
      // on reload; each cycle starts only from the preceding saved checkpoint.
      const reloaded = JSON.parse(
        JSON.stringify(buildSummaryMessage(result.text)),
      );
      history = await convertToModelMessages([reloaded]);
    }
    expect(model.doGenerateCalls).toHaveLength(4);
    const separateChat = [
      { role: "user" as const, content: "Unrelated fixture" },
    ];
    expect(boundModelMessagesForSummarization(separateChat)).toBe(separateChat);
    expect(JSON.stringify(separateChat)).not.toContain("Candidate A");
  });
});
