import { describe, expect, it } from "@jest/globals";
import type { ModelMessage } from "ai";
import {
  appendPlatformAuthorizationToLatestUserMessage,
  PLATFORM_AUTHORIZATION_ANNOTATION,
} from "../platform-authorization";

describe("appendPlatformAuthorizationToLatestUserMessage", () => {
  it("appends the exact canonical tag only when moderation authorized it", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "Testa la mia API" },
    ];

    expect(
      appendPlatformAuthorizationToLatestUserMessage(messages, false),
    ).toBe(messages);

    const authorized = appendPlatformAuthorizationToLatestUserMessage(
      messages,
      true,
    );
    expect(authorized).toEqual([
      {
        role: "user",
        content: `Testa la mia API ${PLATFORM_AUTHORIZATION_ANNOTATION}`,
      },
    ]);
  });

  it("does not mutate provider input while preserving non-text content", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this screenshot" },
          { type: "image", image: new URL("https://example.com/image.png") },
        ],
      },
    ];
    const originalContent = messages[0].content;

    const authorized = appendPlatformAuthorizationToLatestUserMessage(
      messages,
      true,
    );

    expect(messages[0].content).toBe(originalContent);
    expect(messages[0].content).toEqual([
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", image: new URL("https://example.com/image.png") },
    ]);
    expect(authorized[0].content).toEqual([
      { type: "text", text: "Inspect this screenshot" },
      { type: "image", image: new URL("https://example.com/image.png") },
      { type: "text", text: PLATFORM_AUTHORIZATION_ANNOTATION },
    ]);
  });
});
