import {
  stripOpenRouterReasoningMetadataFromMessage,
  stripOpenRouterReasoningMetadataFromMessages,
  stripOpenRouterReasoningMetadataFromParts,
} from "../provider-metadata-sanitizer";

describe("OpenRouter reasoning metadata sanitizer", () => {
  it("keeps reasoning parts and strips reasoning_details from metadata", () => {
    const message = {
      id: "assistant-1",
      role: "assistant",
      parts: [
        {
          type: "reasoning",
          state: "done",
          text: "private chain of thought",
          providerMetadata: {
            openrouter: {
              reasoning_details: [
                { type: "reasoning.text", text: "private chain of thought" },
              ],
            },
          },
        },
        {
          type: "tool-run_terminal_cmd",
          toolCallId: "call-1",
          state: "output-available",
          input: { command: "echo hi" },
          output: { result: { exitCode: 0, output: "hi" } },
          providerMetadata: {
            openrouter: {
              generation_id: "gen-1",
              reasoning_details: [
                { type: "reasoning.text", text: "tool-call thought" },
              ],
            },
            google: {
              thought_signature: "gemini-signature",
            },
          },
          callProviderMetadata: {
            openrouter: {
              reasoning_details: [
                { type: "reasoning.text", text: "call thought" },
              ],
            },
          },
          resultProviderMetadata: {
            openrouter: {
              reasoning_details: [
                { type: "reasoning.text", text: "result thought" },
              ],
            },
          },
        },
      ],
    };

    const sanitized = stripOpenRouterReasoningMetadataFromMessage(message);

    expect(sanitized).not.toBe(message);
    expect(sanitized.parts).toHaveLength(2);
    expect(sanitized.parts[0]).toMatchObject({
      type: "reasoning",
      state: "done",
      text: "private chain of thought",
    });
    expect((sanitized.parts[0] as any).providerMetadata).toBeUndefined();
    expect(sanitized.parts[1]).toMatchObject({
      type: "tool-run_terminal_cmd",
      providerMetadata: {
        openrouter: { generation_id: "gen-1" },
        google: { thought_signature: "gemini-signature" },
      },
    });
    expect((sanitized.parts[1] as any).callProviderMetadata).toBeUndefined();
    expect((sanitized.parts[1] as any).resultProviderMetadata).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("reasoning_details");
  });

  it("preserves non-OpenRouter provider metadata unchanged", () => {
    const parts = [
      {
        type: "tool-run_terminal_cmd",
        toolCallId: "call-1",
        state: "output-available",
        providerMetadata: {
          google: {
            thought_signature: "gemini-signature",
          },
        },
      },
    ];

    expect(stripOpenRouterReasoningMetadataFromParts(parts)).toBe(parts);
    expect(stripOpenRouterReasoningMetadataFromMessages([{ parts }])).toEqual([
      { parts },
    ]);
  });
});
