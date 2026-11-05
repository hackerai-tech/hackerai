import type { ModelMessage } from "ai";
import { getProviderRequestMediaCounts } from "../provider-request-media";

describe("provider request media counts", () => {
  it("distinguishes image representations, roles and non-image files", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: "https://private.test/image" },
          { type: "image", image: new URL("https://private.test/other") },
          { type: "file", data: new Uint8Array([1]), mediaType: "image/png" },
          { type: "file", data: "private-pdf", mediaType: "application/pdf" },
          { type: "file", data: "private-file", mediaType: "text/plain" },
        ],
      },
      {
        role: "assistant",
        content: [
          { type: "file", data: new ArrayBuffer(1), mediaType: "image/jpeg" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "fixture",
            toolName: "file",
            output: {
              type: "content",
              value: [
                {
                  type: "image-data",
                  data: "cHJpdmF0ZQ==",
                  mediaType: "image/png",
                },
                { type: "image-url", url: "https://private.test/tool" },
                { type: "image-file-id", fileId: "private-provider-id" },
                {
                  type: "media",
                  data: "data:image/png;base64,cA==",
                  mediaType: "image/png",
                },
                {
                  type: "file-url",
                  url: "https://private.test/file",
                  mediaType: "image/png",
                },
                {
                  type: "file-data",
                  data: "private-pdf",
                  mediaType: "application/pdf",
                },
                { type: "file-id", fileId: "private-untyped-id" },
                { type: "text", text: "private text" },
              ],
            },
          },
        ],
      },
    ];
    const before = JSON.stringify(messages);

    expect(getProviderRequestMediaCounts(messages)).toEqual({
      image_parts: 9,
      user_image_parts: 3,
      assistant_image_parts: 1,
      tool_image_parts: 5,
      other_image_parts: 0,
      url_images: 4,
      inline_images: 4,
      provider_id_images: 1,
      unknown_images: 0,
      pdf_file_parts: 2,
      other_file_parts: 2,
    });
    expect(JSON.stringify(messages)).toBe(before);
  });

  it("ignores image-shaped private JSON, text and custom blocks", () => {
    const privateImage = {
      type: "image-url",
      url: "https://private.test/secret",
    };
    const messages: ModelMessage[] = [
      { role: "user", content: JSON.stringify(privateImage) },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "json",
            toolName: "file",
            output: { type: "json", value: { content: [privateImage] } },
          },
          {
            type: "tool-result",
            toolCallId: "error",
            toolName: "file",
            output: { type: "error-json", value: privateImage },
          },
          {
            type: "tool-result",
            toolCallId: "content",
            toolName: "file",
            output: {
              type: "content",
              value: [
                {
                  type: "custom",
                  providerOptions: { private: { content: [privateImage] } },
                },
              ],
            },
          },
        ],
      },
    ];
    const counts = getProviderRequestMediaCounts(messages);

    expect(Object.values(counts)).toEqual(Array(11).fill(0));
    expect(JSON.stringify(counts)).not.toContain("private");
  });

  it("keeps unknown image sources in fixed numeric buckets", () => {
    const messages = [
      {
        role: "private-custom-role",
        content: [
          { type: "image", image: null },
          { type: "image", image: "file:///private/secret.png" },
          { type: "image", image: "" },
          { type: "image", image: new URL("data:image/png;base64,cA==") },
          { type: "private-custom-part", image: "private-content" },
        ],
      },
    ] as unknown as ModelMessage[];
    const counts = getProviderRequestMediaCounts(messages);

    expect(counts).toMatchObject({
      image_parts: 4,
      other_image_parts: 4,
      unknown_images: 3,
      inline_images: 1,
    });
    expect(Object.values(counts).every(Number.isSafeInteger)).toBe(true);
    expect(JSON.stringify(counts)).not.toMatch(/private|secret|data:|file:/);
  });
});
