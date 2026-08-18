import fs from "fs";
import path from "path";
import {
  requireChatMessagesArray,
  requireRetiredTemporaryFieldAbsent,
  requireVercelChatMode,
} from "@/lib/api/chat-request-validation";

describe("chat-handler request validation", () => {
  it("enforces the Trigger.dev Agent boundary before Vercel auth or billing work", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../chat-handler.ts"),
      "utf8",
    );
    const modeBoundary = source.indexOf("requireVercelChatMode(rawMode)");
    const authentication = source.indexOf("getUserIDAndPro(req)");
    const billingGate = source.indexOf(
      "assertUserCanMakeCostIncurringRequest(userId)",
    );

    expect(modeBoundary).toBeGreaterThan(-1);
    expect(modeBoundary).toBeLessThan(authentication);
    expect(modeBoundary).toBeLessThan(billingGate);
  });

  it.each([true, false])(
    "rejects retired temporary=%s before persistence",
    (temporary) => {
      const persist = jest.fn();

      expect(() => {
        const body = { messages: [], temporary };
        requireRetiredTemporaryFieldAbsent(body);
        persist(body);
      }).toThrow(
        expect.objectContaining({
          type: "bad_request",
          surface: "api",
          statusCode: 400,
          cause: "Invalid chat request: temporary is no longer supported.",
          metadata: expect.objectContaining({
            invalid_request_field: "temporary",
            invalid_request_field_reason: "retired_field",
          }),
        }),
      );

      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("accepts requests that omit the retired temporary field", () => {
    expect(() =>
      requireRetiredTemporaryFieldAbsent({ messages: [] }),
    ).not.toThrow();
  });

  it("rejects legacy Vercel Agent execution before downstream work", () => {
    expect(() => requireVercelChatMode("agent")).toThrow(
      expect.objectContaining({
        type: "bad_request",
        surface: "api",
        statusCode: 400,
        cause:
          "Agent requests must use the Trigger.dev-backed /api/agent endpoint.",
        metadata: expect.objectContaining({
          invalid_request_field: "mode",
          invalid_request_field_reason: "agent_requires_trigger_route",
          required_endpoint: "/api/agent",
        }),
      }),
    );
  });

  it("keeps /api/chat limited to ask mode", () => {
    expect(requireVercelChatMode("ask")).toBe("ask");
    expect(() => requireVercelChatMode("unknown")).toThrow(
      expect.objectContaining({
        type: "bad_request",
        metadata: expect.objectContaining({
          invalid_request_field: "mode",
          invalid_request_field_reason: "invalid_mode",
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

  it.each(["text", "reasoning"] as const)(
    "rejects non-string %s before token counting",
    (partType) => {
      expect(() =>
        requireChatMessagesArray([
          {
            id: "message-1",
            role: "user",
            parts: [{ type: partType, text: ["not", "text"] }],
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
    },
  );

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
