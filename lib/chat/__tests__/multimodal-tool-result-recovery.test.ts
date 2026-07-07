import type { UIMessage } from "ai";
import {
  getImageToolResultOmittedText,
  isProviderMultimodalToolResultRejectionError,
  omitImageViewToolResultsForProviderRetry,
  omitTrailingStepStartAssistantMessage,
  toolResultsContainImageViewResult,
  uiMessagesContainImageViewResult,
} from "../multimodal-tool-result-recovery";

const makeImageViewMessage = (): UIMessage =>
  ({
    id: "assistant-1",
    role: "assistant",
    parts: [
      {
        type: "tool-file",
        toolCallId: "call-file-1",
        state: "output-available",
        output: {
          action: "view",
          kind: "image",
          mediaType: "image/png",
          data: "base64-image-data",
          previewFiles: [{ fileName: "screen.png" }],
        },
      },
    ],
  }) as unknown as UIMessage;

describe("multimodal tool result recovery", () => {
  it("detects image view tool results in UI messages and tool results", () => {
    const message = makeImageViewMessage();

    expect(uiMessagesContainImageViewResult([message])).toBe(true);
    expect(
      toolResultsContainImageViewResult([
        {
          toolName: "file",
          output: {
            action: "view",
            kind: "image",
            mediaType: "image/jpeg",
          },
        },
      ]),
    ).toBe(true);
    expect(
      toolResultsContainImageViewResult([
        {
          toolName: "file",
          output: {
            action: "read",
            kind: "text",
            mediaType: "text/plain",
          },
        },
      ]),
    ).toBe(false);
  });

  it("replaces image view outputs with text placeholders for retry", () => {
    const message = makeImageViewMessage();
    const originalMessages = [message];
    const { messages, omittedCount } =
      omitImageViewToolResultsForProviderRetry(originalMessages);

    expect(omittedCount).toBe(1);
    expect(messages).not.toBe(originalMessages);
    expect(uiMessagesContainImageViewResult(messages)).toBe(false);

    const output = (messages[0]?.parts?.[0] as any)?.output;
    expect(output.content).toBe(getImageToolResultOmittedText());
    expect(output.error).toBe(getImageToolResultOmittedText());
    expect(output.imageOmittedAfterProviderRejection).toBe(true);
    expect(output.data).toBeUndefined();
    expect(output.previewFiles).toBeUndefined();
  });

  it("leaves non-image file tool outputs unchanged", () => {
    const messages = [
      {
        id: "assistant-1",
        role: "assistant",
        parts: [
          {
            type: "tool-file",
            output: {
              action: "read",
              kind: "text",
              mediaType: "text/plain",
              content: "hello",
            },
          },
        ],
      },
    ] as unknown as UIMessage[];

    const result = omitImageViewToolResultsForProviderRetry(messages);

    expect(result.omittedCount).toBe(0);
    expect(result.messages).toBe(messages);
  });

  it("removes a trailing transient step-start assistant message", () => {
    const messages = [
      makeImageViewMessage(),
      {
        id: "assistant-step",
        role: "assistant",
        parts: [{ type: "step-start" }],
      },
    ] as unknown as UIMessage[];

    const trimmed = omitTrailingStepStartAssistantMessage(messages);

    expect(trimmed).toHaveLength(1);
    expect(trimmed[0]).toBe(messages[0]);
  });

  it("classifies provider 4xx image tool-output rejections", () => {
    const error = Object.assign(
      new Error("Provider rejected image-data in tool output"),
      {
        name: "AI_APICallError",
        statusCode: 400,
      },
    );

    expect(isProviderMultimodalToolResultRejectionError(error)).toBe(true);

    expect(
      isProviderMultimodalToolResultRejectionError(
        Object.assign(
          new Error(
            "Received 404 status code when fetching image from URL: https://example.com/missing.png",
          ),
          {
            name: "AI_APICallError",
            statusCode: 400,
          },
        ),
      ),
    ).toBe(true);
  });

  it("does not treat media size or retryable provider errors as image rejection", () => {
    expect(
      isProviderMultimodalToolResultRejectionError(
        Object.assign(new Error("image file too large"), {
          name: "AI_APICallError",
          statusCode: 400,
        }),
      ),
    ).toBe(false);

    expect(
      isProviderMultimodalToolResultRejectionError(
        Object.assign(new Error("Provider unavailable for image input"), {
          name: "AI_APICallError",
          statusCode: 503,
        }),
      ),
    ).toBe(false);
  });
});
