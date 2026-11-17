import type { ModelMessage } from "ai";
import {
  buildContextBudgetProjectionDiagnostics,
  CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS,
  CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_CONTENT_PARTS,
  CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_URL_CHARS,
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
      // Text-only and content-less files are a measured zero, not absence.
      context_budget_annotation_image_diagnostic_version: 1,
      context_budget_annotation_image_status: "measured",
      context_budget_annotation_image_part_count: 0,
      context_budget_annotation_image_url_chars: 0,
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
      // Absence (including a stale history array) is never a measured zero.
      expect(result.context_budget_annotation_image_status).toBe("not_present");
      expect(result).not.toHaveProperty(
        "context_budget_annotation_image_part_count",
      );
      expect(result).not.toHaveProperty(
        "context_budget_annotation_image_url_chars",
      );
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
      context_budget_annotation_image_diagnostic_version: 1,
      context_budget_annotation_image_status: "not_present",
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

describe("annotation image composition diagnostics", () => {
  const IMAGE_CANARY = "PRIVATE_IMAGE_CANARY";
  const textPart = { type: "text", text: ANNOTATION_CANARY };
  const imagePart = (url: string) => ({
    type: "image_url",
    image_url: { url },
  });
  const file = (content?: unknown) => ({
    type: "file",
    file: { hash: "synthetic-hash", name: `${ANNOTATION_CANARY}.pdf`, content },
  });
  const run = (attached: unknown[]) => {
    const countTokens = jest.fn(() => 77);
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: preparedWith(attached),
      attachedFileAnnotations: attached,
      countTokens,
    });
    return { result, countTokens };
  };
  const expectNoImageCounts = (result: object) => {
    expect(result).not.toHaveProperty(
      "context_budget_annotation_image_part_count",
    );
    expect(result).not.toHaveProperty(
      "context_budget_annotation_image_url_chars",
    );
  };

  it("aggregates image URL parts across files without reading text or URLs", () => {
    const attached = [
      file([textPart, imagePart(`data:image/png;base64,${IMAGE_CANARY}`)]),
      file([imagePart("https://img.example/\u{1F600}"), textPart]),
      file([textPart]),
      file(),
    ];
    const prepared = preparedWith(attached);
    const snapshot = JSON.parse(JSON.stringify(prepared));
    const countTokens = jest.fn(() => 77);

    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
      countTokens,
    });

    expect(result).toMatchObject({
      context_budget_annotation_image_diagnostic_version: 1,
      context_budget_annotation_image_status: "measured",
      context_budget_annotation_image_part_count: 2,
      // 42 + 22 UTF-16 code units; the emoji is two units (four UTF-8 bytes).
      context_budget_annotation_image_url_chars: 64,
      // The existing group is unchanged and tokenizes exactly once.
      context_budget_without_file_annotations_status: "measured",
      context_budget_without_file_annotations_message_tokens: 77,
      context_budget_file_annotation_count: 4,
    });
    expect(countTokens).toHaveBeenCalledTimes(1);
    expect(prepared).toEqual(snapshot);
    expect(
      (prepared[3].providerOptions?.openrouter as { annotations?: unknown })
        .annotations,
    ).toBe(attached);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(IMAGE_CANARY);
    expect(serialized).not.toContain(ANNOTATION_CANARY);
    expect(serialized).not.toContain("img.example");
  });

  describe("shared batch bounds", () => {
    const halfUrl = "x".repeat(
      CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_URL_CHARS / 2,
    );
    const partsPerFile =
      CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_CONTENT_PARTS /
      CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS;
    // Every file is far below each limit; only the whole batch reaches them,
    // with the first image already counted before any later overflow.
    const atSharedLimits = ({
      extraAnnotation = false,
      extraPart = false,
      extraChar = false,
    } = {}) => {
      const batch = Array.from(
        { length: CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS },
        () => {
          const content: unknown[] = Array(partsPerFile).fill(textPart);
          return file(content) as { file: { content: unknown[] } };
        },
      );
      const last = batch[batch.length - 1].file.content;
      batch[0].file.content[0] = imagePart(halfUrl);
      last[0] = imagePart(extraChar ? `${halfUrl}x` : halfUrl);
      if (extraPart) last.push(textPart);
      if (extraAnnotation) batch.push(file([]) as never);
      return batch;
    };

    it("measures a batch exactly at every shared limit", () => {
      const { result } = run(atSharedLimits());
      expect(result).toMatchObject({
        context_budget_annotation_image_status: "measured",
        context_budget_annotation_image_part_count: 2,
        context_budget_annotation_image_url_chars:
          CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_URL_CHARS,
      });
    });

    it.each([
      ["annotation count", { extraAnnotation: true }],
      ["total content parts", { extraPart: true }],
      ["total image URL characters", { extraChar: true }],
    ])(
      "reports size_cap without partial counts when the batch exceeds the %s",
      (_case, overflow) => {
        const { result, countTokens } = run(atSharedLimits(overflow));
        expect(result.context_budget_annotation_image_status).toBe("size_cap");
        expectNoImageCounts(result);
        expect(result.context_budget_without_file_annotations_status).toBe(
          "measured",
        );
        expect(countTokens).toHaveBeenCalledTimes(1);
      },
    );
  });

  const throwingGetter = (target: object, key: string) =>
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        throw new Error(ANNOTATION_CANARY);
      },
    });

  it.each([
    ["a non-object annotation", () => null],
    [
      "a non-file annotation",
      () => ({ type: "url_citation", url_citation: { url: IMAGE_CANARY } }),
    ],
    ["a file annotation without file metadata", () => ({ type: "file" })],
    ["non-array content", () => file(IMAGE_CANARY)],
    ["a null content part", () => file([null])],
    [
      "an unknown content part type",
      () =>
        file([{ type: "input_audio", input_audio: { data: IMAGE_CANARY } }]),
    ],
    [
      "an image part without a string URL",
      () => file([{ type: "image_url", image_url: { url: 42 } }]),
    ],
    [
      "a throwing content getter",
      () => {
        const annotation = file();
        throwingGetter(annotation.file, "content");
        return annotation;
      },
    ],
    ["a throwing part type getter", () => file([throwingGetter({}, "type")])],
  ])(
    "reports unavailable instead of a misleading count for %s",
    (_case, malformed) => {
      // A valid image is counted first, so a partial result would be non-zero.
      const attached = [file([imagePart(IMAGE_CANARY)]), malformed()];
      const { result, countTokens } = run(attached);
      expect(result.context_budget_annotation_image_status).toBe("unavailable");
      expectNoImageCounts(result);
      // The independent existing group is still reported in full.
      expect(result).toMatchObject({
        context_budget_without_file_annotations_status: "measured",
        context_budget_without_file_annotations_message_tokens: 77,
        context_budget_file_annotation_count: 2,
      });
      expect(countTokens).toHaveBeenCalledTimes(1);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(IMAGE_CANARY);
      expect(serialized).not.toContain(ANNOTATION_CANARY);
    },
  );

  it("reports unavailable when resolving the attached target throws", () => {
    const attached = [file([imagePart(IMAGE_CANARY)])];
    const prepared = preparedWith(attached);
    throwingGetter(prepared[3], "providerOptions");
    const result = buildContextBudgetProjectionDiagnostics({
      ...base,
      preparedMessages: prepared,
      attachedFileAnnotations: attached,
      countTokens: () => 1,
    });
    expect(result.context_budget_annotation_image_status).toBe("unavailable");
    expectNoImageCounts(result);
    expect(JSON.stringify(result)).not.toContain(ANNOTATION_CANARY);
  });
});
