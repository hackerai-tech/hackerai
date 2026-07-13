import {
  requireBooleanFlag,
  requireChatMessagesArray,
} from "@/lib/api/chat-request-validation";

describe("chat-handler request validation", () => {
  it("accepts only boolean request flags", () => {
    expect(requireBooleanFlag("temporary", undefined)).toBe(false);
    expect(requireBooleanFlag("temporary", false)).toBe(false);
    expect(requireBooleanFlag("temporary", true)).toBe(true);

    expect(() => requireBooleanFlag("temporary", "false")).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        cause: "Invalid chat request: temporary must be a boolean.",
        metadata: expect.objectContaining({
          invalid_request_field: "temporary",
          invalid_request_field_type: "string",
          invalid_request_field_reason: "not_boolean",
        }),
      }),
    );
  });

  it("rejects non-array messages as a bad request", () => {
    expect(() => requireChatMessagesArray({ id: "not-array" })).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        cause:
          "Invalid chat request: messages must be an array of UI messages.",
        metadata: expect.objectContaining({
          invalid_request_field: "messages",
          invalid_request_field_type: "object",
          invalid_request_field_reason: "not_array",
        }),
      }),
    );
  });

  it("rejects malformed array entries before downstream message processing", () => {
    expect(() => requireChatMessagesArray([null])).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        metadata: expect.objectContaining({
          invalid_request_field: "messages[0]",
          invalid_request_field_type: "null",
          invalid_request_field_reason: "not_object",
        }),
      }),
    );

    expect(() =>
      requireChatMessagesArray([
        { id: "message-1", role: "user", parts: [null] },
      ]),
    ).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        metadata: expect.objectContaining({
          invalid_request_field: "messages[0].parts[0]",
          invalid_request_field_type: "null",
          invalid_request_field_reason: "not_object",
        }),
      }),
    );
  });

  it("rejects non-string text before token counting", () => {
    expect(() =>
      requireChatMessagesArray([
        {
          id: "message-1",
          role: "user",
          parts: [{ type: "text", text: ["not", "text"] }],
        },
      ]),
    ).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        metadata: expect.objectContaining({
          invalid_request_field: "messages[0].parts[0].text",
          invalid_request_field_type: "array",
          invalid_request_field_reason: "invalid_text",
        }),
      }),
    );
  });

  it("returns valid UI messages unchanged", () => {
    const messages = [
      {
        id: "message-1",
        role: "user" as const,
        parts: [{ type: "text" as const, text: "hi" }],
      },
    ];

    expect(requireChatMessagesArray(messages)).toBe(messages);
  });
});
