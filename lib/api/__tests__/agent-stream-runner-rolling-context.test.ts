import type { ModelMessage } from "ai";
import {
  addOpenRouterFileAnnotationsToLastAssistantMessage,
  getOpenRouterFileAnnotations,
  getOpenRouterFileAnnotationsForRequest,
} from "@/lib/api/agent-stream-runner";
import {
  CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS,
  CONTEXT_BUDGET_PREPARED_PDF_MAX_MESSAGES,
} from "@/lib/chat/summarization/context-budget-diagnostics";
import {
  DEEPSEEK_1017_CANONICAL_SLUG,
  DEEPSEEK_1017_SLUG,
} from "@/lib/experiments/paid-deepseek-1017";

jest.mock("@/lib/db/actions", () => ({}));

// Rolling checkpoint cases live with the shared module in
// lib/chat/summarization/__tests__/rolling-context.test.ts.
const user = (content: string): ModelMessage => ({ role: "user", content });
const assistant = (content: string): ModelMessage => ({
  role: "assistant",
  content,
});

describe("OpenRouter PDF annotation reuse", () => {
  it("extracts parsed-file annotations from provider metadata", () => {
    const annotations = [{ type: "file", file: { hash: "pdf-hash" } }];

    expect(
      getOpenRouterFileAnnotations({ openrouter: { annotations } }),
    ).toEqual(annotations);
    expect(getOpenRouterFileAnnotations({ openrouter: {} })).toBeUndefined();
  });

  it("adds parsed-file annotations to the last assistant message", () => {
    const annotations = [{ type: "file", file: { hash: "pdf-hash" } }];
    const messages = [
      user("read the report"),
      assistant("I will inspect it."),
      user("continue"),
    ];

    const result = addOpenRouterFileAnnotationsToLastAssistantMessage(
      messages,
      annotations,
    );

    expect((result[1] as any).providerOptions).toEqual({
      openrouter: { annotations },
    });
    expect(result[0]).toBe(messages[0]);
    expect(result[2]).toBe(messages[2]);
  });
});

describe("route-scoped orphaned parsed-file annotations", () => {
  // Synthetic shapes only: a parsed page with an embedded page image.
  const fileAnnotation = (name: string) => ({
    type: "file",
    file: {
      hash: `${name}-hash`,
      name,
      content: [
        { type: "text", text: "synthetic page text" },
        {
          type: "image_url",
          image_url: { url: "data:image/png;base64,AAAA" },
        },
      ],
    },
  });
  const citation = {
    type: "url_citation",
    url_citation: { url: "https://example.test/", title: "kept" },
  };
  const bytes = () => new Uint8Array([1, 2, 3]);
  const userParts = (...content: unknown[]) =>
    ({ role: "user", content }) as ModelMessage;
  const toolOutput = (output: unknown) =>
    ({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call",
          toolName: "run_terminal_cmd",
          output,
        },
      ],
    }) as ModelMessage;
  // Compacted history whose every part provably serializes to no wire file:
  // binary images, screenshots and string tool outputs.
  const withoutOriginal = (...extra: ModelMessage[]): ModelMessage[] => [
    userParts(
      { type: "text", text: "summary of earlier work" },
      { type: "image", image: bytes() },
      { type: "file", data: bytes(), mediaType: "image/png" },
    ),
    assistant("Continuing."),
    toolOutput({
      type: "content",
      value: [
        { type: "text", text: "captured" },
        { type: "image-data", data: "AAAA", mediaType: "image/png" },
        { type: "file-data", data: "AAAA", mediaType: "image/png" },
        { type: "media", data: "AAAA", mediaType: "image/png" },
      ],
    }),
    toolOutput({ type: "json", value: { file: "report.pdf" } }),
    ...extra,
    user("continue"),
  ];
  const select = (
    messages: ModelMessage[],
    annotations: unknown[] | undefined,
    overrides: { routeAwareContext?: boolean; modelId?: string } = {},
  ) =>
    getOpenRouterFileAnnotationsForRequest({
      messages,
      annotations,
      routeAwareContext: true,
      modelId: DEEPSEEK_1017_SLUG,
      ...overrides,
    });

  it("attaches nothing when every entry is a parsed file and no original can be sent", () => {
    const messages = withoutOriginal();
    const annotations = [fileAnnotation("a.pdf"), fileAnnotation("b.pdf")];
    const annotationsBefore = JSON.parse(JSON.stringify(annotations));

    const selected = select(messages, annotations);

    expect(selected).toBeUndefined();
    expect(
      addOpenRouterFileAnnotationsToLastAssistantMessage(messages, selected),
    ).toBe(messages);
    expect(annotations).toEqual(annotationsBefore);
  });

  it("drops only parsed-file entries and keeps other entries intact", () => {
    const file = fileAnnotation("a.pdf");
    const annotations = [file, citation];

    const selected = select(withoutOriginal(), annotations);

    expect(selected).toEqual([citation]);
    expect(selected?.[0]).toBe(citation);
    expect(annotations).toEqual([file, citation]);
  });

  // Each case adds one possible original (or uncertainty) to the history above.
  it.each<[string, () => ModelMessage[], () => unknown[]]>([
    [
      "a typed user PDF",
      () =>
        withoutOriginal(
          userParts({
            type: "file",
            data: "JVBERi0xLjQ=",
            mediaType: "application/pdf",
          }),
        ),
      () => [fileAnnotation("a.pdf"), citation],
    ],
    [
      "a user file whose image label a data URL could replace",
      () =>
        withoutOriginal(
          userParts({ type: "file", data: "opaque", mediaType: "image/png" }),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "a user image whose data is not binary",
      () => withoutOriginal(userParts({ type: "image", image: "opaque" })),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "a binary user file with a generic media type",
      () =>
        withoutOriginal(
          userParts({
            type: "file",
            data: bytes(),
            mediaType: "application/octet-stream",
          }),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "tool file-data that is not image or video",
      () =>
        withoutOriginal(
          toolOutput({
            type: "content",
            value: [
              { type: "file-data", data: "AAAA", mediaType: "audio/mpeg" },
            ],
          }),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "a tool file-url, even one that looks like an image",
      () =>
        withoutOriginal(
          toolOutput({
            type: "content",
            value: [
              {
                type: "file-url",
                url: "https://example.test/a.png",
                mediaType: "image/png",
              },
            ],
          }),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "tool media that becomes file-data",
      () =>
        withoutOriginal(
          toolOutput({
            type: "content",
            value: [
              { type: "media", data: "AAAA", mediaType: "application/pdf" },
            ],
          }),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "an unrecognized user part",
      () => withoutOriginal(userParts({ type: "unknown-part" })),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "an unrecognized tool output",
      () => withoutOriginal(toolOutput({ type: "future-output" })),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "a request above the message scan bound",
      () =>
        withoutOriginal(
          ...Array.from(
            { length: CONTEXT_BUDGET_PREPARED_PDF_MAX_MESSAGES },
            () => user("turn"),
          ),
        ),
      () => [fileAnnotation("a.pdf")],
    ],
    [
      "an annotation entry without a type",
      withoutOriginal,
      () => [fileAnnotation("a.pdf"), { file: { hash: "h", name: "n" } }],
    ],
    [
      "a batch above the annotation bound",
      withoutOriginal,
      () =>
        Array.from(
          { length: CONTEXT_BUDGET_ANNOTATION_IMAGE_MAX_ANNOTATIONS + 1 },
          (_, index) => fileAnnotation(`${index}.pdf`),
        ),
    ],
  ])("keeps the full batch for %s", (_case, messages, annotations) => {
    const batch = annotations();

    expect(select(messages(), batch)).toBe(batch);
  });

  it.each([
    ["non-route-aware or Ask", false, DEEPSEEK_1017_SLUG],
    ["the canonical DeepSeek slug", true, DEEPSEEK_1017_CANONICAL_SLUG],
    ["another model", true, "z-ai/glm-5.3"],
  ])(
    "keeps the existing replay for %s",
    (_case, routeAwareContext, modelId) => {
      const annotations = [fileAnnotation("a.pdf")];

      expect(
        select(withoutOriginal(), annotations, { routeAwareContext, modelId }),
      ).toBe(annotations);
    },
  );
});
