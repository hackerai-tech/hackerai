import { createWideEventBuilder, logger } from "../logger";

describe("sandbox logging", () => {
  it("records Miosa as a cloud sandbox without labeling its type as E2B", () => {
    const event = createWideEventBuilder("chat_123", "/api/agent-long")
      .setSandbox({ type: "cloud", provider: "miosa" })
      .build();

    expect(event.sandbox).toEqual({
      type: "cloud",
      provider: "miosa",
    });
  });
});

describe("diagnostic logging context", () => {
  it("reuses an upstream request id and exposes model/provider attribution", () => {
    const builder = createWideEventBuilder(
      "chat_123",
      "/api/chat",
      "fra1::request-123",
    );
    builder.setRequestDetails({ mode: "ask", isRegenerate: false });
    builder.setUser({ id: "user_123", subscription: "pro" });
    builder.setModel("model-opus-4.6");
    builder.setProviderRequestDiagnostics({
      model: "model-opus-4.6",
      requested_model_slug: "anthropic/claude-opus-4.6",
      step_index: 0,
      source: "initial",
      message_count: 1,
      role_counts: { user: 1 },
      content_part_counts: { text: 1 },
      context_used_tokens: 10,
      context_max_tokens: 100,
      context_used_percent: 10,
      system_tokens: 5,
      max_output_tokens: 100,
      tool_count: 0,
      active_tool_count: 0,
      active_tools_mode: "all",
      fallback_model_count: 0,
      has_user_attribution: true,
      has_multimodal_tool_results: false,
    });
    builder.setActualModel("anthropic/claude-opus-4.6");
    builder.setOpenRouterMetadata({
      provider_name: "Google Vertex",
      openrouter_generation_id: "gen-123",
      openrouter_request_id: "or-req-123",
    });

    expect(builder.getDiagnosticContext()).toEqual({
      request_id: "fra1::request-123",
      service: "chat-handler",
      environment: expect.any(String),
      user_id: "user_123",
      mode: "ask",
      subscription: "pro",
      selected_model: "model-opus-4.6",
      requested_model_slug: "anthropic/claude-opus-4.6",
      model_provider_slug: "anthropic",
      response_model: "anthropic/claude-opus-4.6",
      provider_name: "Google Vertex",
      provider_name_source: "openrouter_response_metadata",
      provider_attribution_available: true,
      openrouter_generation_id: "gen-123",
      openrouter_request_id: "or-req-123",
      openrouter_upstream_id: undefined,
    });
    expect(builder.build()).toMatchObject({
      request_id: "fra1::request-123",
      environment: expect.any(String),
    });
  });
});

describe("logger error redaction", () => {
  it("redacts presigned URLs from runtime error messages and stacks", () => {
    const consoleError = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const signedUrl =
      "https://bucket.s3.amazonaws.com/user-files/user_123/private-image.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=access-key&X-Amz-Signature=signature-secret";
    const error = new Error(`Provider could not fetch ${signedUrl}`);

    try {
      logger.error("Provider request failed", error, {
        event: "provider_request_failed",
        message: signedUrl,
        error: signedUrl,
      });

      const serialized = String(consoleError.mock.calls[0]?.[0]);
      const parsed = JSON.parse(serialized) as {
        message?: string;
        error?: { message?: string };
      };

      expect(serialized).toContain("[Redacted signed URL]");
      expect(serialized).not.toContain("user-files");
      expect(serialized).not.toContain("access-key");
      expect(serialized).not.toContain("signature-secret");
      expect(parsed.message).toBe("Provider request failed");
      expect(parsed.error?.message).toContain("[Redacted signed URL]");
    } finally {
      consoleError.mockRestore();
    }
  });
});
