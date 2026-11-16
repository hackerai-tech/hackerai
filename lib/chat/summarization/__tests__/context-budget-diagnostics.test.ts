import type { ModelMessage } from "ai";
import {
  buildContextBudgetProjectionDiagnostics,
  CONTEXT_BUDGET_DECISION_NOT_EVALUATED,
  CONTEXT_BUDGET_DIAGNOSTIC_MAX_CHARS,
} from "../context-budget-diagnostics";
import { estimateSummaryInputTokens } from "../helpers";

const ANNOTATION_CANARY = "PRIVATE_ANNOTATION_CANARY";

const annotations = () => [
  {
    type: "file",
    file: {
      hash: "synthetic-hash",
      name: "synthetic.pdf",
      content: [{ type: "text", text: `${ANNOTATION_CANARY} parsed text` }],
    },
  },
  { type: "file", file: { hash: "second", name: "second.pdf" } },
];

const preparedWith = (attached: unknown[]): ModelMessage[] => [
  { role: "user", content: "Read the attachment" },
  {
    role: "assistant",
    content: "Earlier answer",
    providerOptions: { openrouter: { annotations: [{ old: true }] } },
  },
  { role: "user", content: "Continue" },
  {
    role: "assistant",
    content: [{ type: "text", text: "Reading" }],
    providerOptions: {
      openrouter: {
        reasoning_details: [{ type: "text" }],
        annotations: attached as never,
      },
      anthropic: { cacheControl: { type: "ephemeral" } },
    },
  },
];

const base = {
  stepIndex: 3,
  decision: { source: "rolling_check" as const, inputTokens: 120 },
  preparedMessageTokens: 900,
  systemTokens: 40,
};

describe("buildContextBudgetProjectionDiagnostics", () => {
  it("measures only the attached annotations without mutating the request", () => {
    const attached = annotations();
    const prepared = preparedWith(attached);
    const snapshot = JSON.parse(JSON.stringify(prepared));
    const countTokens = jest.fn(() => 77);

    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
      countTokens,
    });

    expect(result).toEqual({
      context_budget_projection_diagnostic_version: 1,
      context_budget_step_index: 3,
      context_budget_decision_source: "rolling_check",
      context_budget_decision_input_tokens: 120,
      context_budget_prepared_message_tokens: 900,
      context_budget_system_tokens: 40,
      context_budget_without_file_annotations_status: "measured",
      context_budget_without_file_annotations_message_tokens: 77,
      context_budget_file_annotation_count: 2,
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
    const projection = JSON.parse(countTokens.mock.calls[0][0]);
    // Only the exact attached array is removed; earlier history annotations,
    // sibling OpenRouter metadata, other namespaces and messages remain.
    expect(projection).toEqual([
      prepared[0],
      prepared[1],
      prepared[2],
      {
        ...prepared[3],
        providerOptions: {
          openrouter: { reasoning_details: [{ type: "text" }] },
          anthropic: { cacheControl: { type: "ephemeral" } },
        },
      },
    ]);
    expect(prepared).toEqual(snapshot);
    expect(
      (prepared[3].providerOptions?.openrouter as { annotations?: unknown })
        .annotations,
    ).toBe(attached);
    expect(JSON.stringify(result)).not.toContain(ANNOTATION_CANARY);
  });

  it("uses the same tokenizer as the guard estimate for the projection", () => {
    const attached = annotations();
    const prepared = preparedWith(attached);
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
    });
    const withoutAttached = preparedWith([]);
    const openrouter = withoutAttached[3].providerOptions!.openrouter as Record<
      string,
      unknown
    >;
    delete openrouter.annotations;
    expect(result.context_budget_without_file_annotations_message_tokens).toBe(
      estimateSummaryInputTokens(withoutAttached),
    );
  });

  it.each([
    ["no annotations were attached", undefined, preparedWith([])],
    ["the attachment list was empty", [], preparedWith([])],
    [
      "the request has no assistant message",
      annotations(),
      [{ role: "user", content: "Only a user turn" }] as ModelMessage[],
    ],
    [
      "the last assistant carries a different array",
      annotations(),
      preparedWith(annotations()),
    ],
  ])(
    "reuses the prepared estimate without tokenizing when %s",
    (_case, attached, prepared) => {
      const countTokens = jest.fn(() => 1);
      const result = buildContextBudgetProjectionDiagnostics({
        ...base,
        preparedMessages: prepared,
        attachedFileAnnotations: attached,
        countTokens,
      });
      expect(countTokens).not.toHaveBeenCalled();
      expect(result.context_budget_without_file_annotations_status).toBe(
        "not_present",
      );
      expect(
        result.context_budget_without_file_annotations_message_tokens,
      ).toBe(900);
      expect(result).not.toHaveProperty("context_budget_file_annotation_count");
    },
  );

  it("reports the size cap before tokenizing an oversized projection", () => {
    const attached = annotations();
    const prepared = preparedWith(attached);
    // The real fixed cap: plain text alone exceeds it and is never tokenized.
    prepared[0] = {
      role: "user",
      content: "x".repeat(CONTEXT_BUDGET_DIAGNOSTIC_MAX_CHARS + 1),
    };
    const countTokens = jest.fn(() => 1);
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
      countTokens,
    });
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.context_budget_without_file_annotations_status).toBe(
      "size_cap",
    );
    expect(result).not.toHaveProperty(
      "context_budget_without_file_annotations_message_tokens",
    );
    expect(result.context_budget_file_annotation_count).toBe(2);
  });

  it.each([
    [
      "the tokenizer throws",
      () => {
        throw new Error(ANNOTATION_CANARY);
      },
    ],
    ["the tokenizer returns NaN", () => Number.NaN],
    ["the tokenizer returns Infinity", () => Number.POSITIVE_INFINITY],
    ["the tokenizer returns a negative count", () => -1],
    ["the tokenizer returns a fraction", () => 1.5],
  ])("reports unavailable when %s", (_case, countTokens) => {
    const attached = annotations();
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: preparedWith(attached),
      attachedFileAnnotations: attached,
      countTokens,
    });
    expect(result.context_budget_without_file_annotations_status).toBe(
      "unavailable",
    );
    expect(result).not.toHaveProperty(
      "context_budget_without_file_annotations_message_tokens",
    );
    expect(JSON.stringify(result)).not.toContain(ANNOTATION_CANARY);
  });

  it("reports unavailable when the projection cannot be serialized", () => {
    const attached = annotations();
    const prepared = preparedWith(attached);
    prepared[0] = {
      role: "user",
      content: "unserializable",
      providerOptions: { custom: { value: BigInt(1) } as never },
    };
    const countTokens = jest.fn(() => 1);
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
      countTokens,
    });
    expect(countTokens).not.toHaveBeenCalled();
    expect(result.context_budget_without_file_annotations_status).toBe(
      "unavailable",
    );
  });

  it("omits missing and invalid numbers instead of reporting zero", () => {
    const result = buildContextBudgetProjectionDiagnostics({
      stepIndex: 1.5,
      decision: CONTEXT_BUDGET_DECISION_NOT_EVALUATED,
      preparedMessageTokens: Number.POSITIVE_INFINITY,
      systemTokens: Number.NaN,
      preparedMessages: preparedWith([]),
    });
    expect(result).toEqual({
      context_budget_projection_diagnostic_version: 1,
      context_budget_decision_source: "not_evaluated",
      context_budget_without_file_annotations_status: "not_present",
    });

    const invalidDecision = buildContextBudgetProjectionDiagnostics({
      ...base,
      decision: { source: "durable_check", inputTokens: Number.NaN },
      preparedMessages: preparedWith([]),
    });
    expect(invalidDecision.context_budget_decision_source).toBe(
      "durable_check",
    );
    expect(invalidDecision).not.toHaveProperty(
      "context_budget_decision_input_tokens",
    );
  });
});
