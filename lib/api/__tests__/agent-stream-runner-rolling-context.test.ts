import type { ModelMessage } from "ai";
import {
  addOpenRouterFileAnnotationsToLastAssistantMessage,
  getOpenRouterFileAnnotations,
} from "@/lib/api/agent-stream-runner";

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
