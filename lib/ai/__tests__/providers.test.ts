import { sanitizeOpenRouterRequestForXai } from "@/lib/ai/providers";

describe("sanitizeOpenRouterRequestForXai", () => {
  it("strips encrypted reasoning details when an OpenRouter fallback can route to xAI", () => {
    const body = {
      model: "google/gemini-3-flash-preview",
      models: ["x-ai/grok-4.3"],
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "text", text: "plain reasoning detail" },
            {
              type: "encrypted",
              encrypted_content: "provider-private-gemini-blob",
            },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      ...body,
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [{ type: "text", text: "plain reasoning detail" }],
        },
      ],
    });
    expect(JSON.stringify(result.body)).not.toContain("encrypted_content");
    expect(JSON.stringify(body)).toContain("encrypted_content");
  });

  it("removes reasoning_details when every detail is encrypted", () => {
    const body = {
      model: "x-ai/grok-4.3",
      messages: [
        {
          role: "assistant",
          content: "Visible text stays.",
          reasoning_details: [
            { type: "encrypted", encrypted_content: "x-provider-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(true);
    expect(result.body).toEqual({
      model: "x-ai/grok-4.3",
      messages: [
        {
          role: "assistant",
          content: "Visible text stays.",
        },
      ],
    });
  });

  it("leaves non-xAI routes unchanged", () => {
    const body = {
      model: "google/gemini-3-flash-preview",
      messages: [
        {
          role: "assistant",
          content: "Here is the answer.",
          reasoning_details: [
            { type: "encrypted", encrypted_content: "gemini-blob" },
          ],
        },
      ],
    };

    const result = sanitizeOpenRouterRequestForXai(body);

    expect(result.changed).toBe(false);
    expect(result.body).toBe(body);
  });
});
