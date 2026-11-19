import type { ModelMessage, UIMessage } from "ai";
import { getProviderRequestMediaCounts } from "../provider-request-media";

describe("provider request media counts", () => {
  it("counts current user file-reference URL matches without retaining private references", () => {
    const url = "https://private.test/image?token=PRIVATE_TOKEN";
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: url },
          { type: "image", image: new URL(url) },
          { type: "image", image: "https://private.test/url-only" },
          {
            type: "file",
            data: "https://private.test/other-role",
            mediaType: "image/png",
          },
          { type: "image", image: "data:image/png;base64,cA==" },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "t",
            toolName: "image",
            output: { type: "content", value: [{ type: "image-url", url }] },
          },
        ],
      },
    ];
    const source: UIMessage[] = [
      {
        id: "private-user",
        role: "user",
        parts: [
          Object.assign(
            { type: "file" as const, mediaType: "image/png", url },
            { fileId: "PRIVATE_FILE_ID" },
          ),
          {
            type: "file",
            mediaType: "image/png",
            url: "https://private.test/url-only",
          },
        ],
      },
      {
        id: "private-assistant",
        role: "assistant",
        parts: [
          Object.assign(
            {
              type: "file" as const,
              mediaType: "image/png",
              url: "https://private.test/other-role",
            },
            { fileId: "PRIVATE_OTHER_ID" },
          ),
        ],
      },
    ];
    const before = JSON.stringify({ messages, source });
    const counts = getProviderRequestMediaCounts(messages, 0, source);
    expect(counts).toMatchObject({
      user_url_images_with_file_reference_match: 2,
      user_url_images_without_file_reference_match: 2,
    });
    expect(JSON.stringify(counts)).not.toMatch(/private|PRIVATE|https|token/);
    expect(JSON.stringify({ messages, source })).toBe(before);
  });

  it("keeps unavailable source context distinct from an explicitly empty snapshot", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image: "https://private.test/image" }],
      },
    ];
    expect(getProviderRequestMediaCounts(messages)).not.toHaveProperty(
      "user_url_images_without_file_reference_match",
    );
    expect(getProviderRequestMediaCounts(messages, 0, [])).toMatchObject({
      user_url_images_with_file_reference_match: 0,
      user_url_images_without_file_reference_match: 1,
    });
  });

  it("keeps existing counts when optional source context cannot be inspected", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image: "https://private.test/image" }],
      },
    ];
    const source = {
      id: "private",
      role: "user" as const,
      get parts(): never {
        throw new Error("PRIVATE context");
      },
    };
    const counts = getProviderRequestMediaCounts(messages, 0, [source]);
    expect(counts.user_image_parts).toBe(1);
    expect(counts).not.toHaveProperty(
      "user_url_images_without_file_reference_match",
    );
  });

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
      url_expiry_hint_expired_images: 0,
      url_expiry_hint_near_images: 0,
      url_expiry_hint_later_images: 0,
      url_expiry_hint_unknown_images: 4,
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

    expect(Object.values(counts)).toEqual(Array(15).fill(0));
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

  it("counts expiry hints across SDK URL image blocks without changing inputs", () => {
    const signed = (date: string, expires = "600") =>
      `https://private.test/image?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${date}&X-Amz-Expires=${expires}&X-Amz-Signature=private-signature`;
    const now = Date.UTC(2026, 10, 7, 9);
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image: signed("20261107T085000Z") },
          { type: "image", image: new URL(signed("20261107T085500Z")) },
          {
            type: "file",
            mediaType: "image/png",
            data: signed("20261107T090000Z"),
          },
          { type: "image", image: "data:image/png;base64,cA==" },
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
                { type: "image-url", url: signed("20261107T085000Z") },
                {
                  type: "file-url",
                  mediaType: "image/png",
                  url: signed("20261107T085501Z"),
                },
                { type: "image-file-id", fileId: "private-id" },
              ],
            },
          },
        ],
      },
    ];
    const before = JSON.stringify(messages);
    const counts = getProviderRequestMediaCounts(messages, now);
    expect(counts).toMatchObject({
      url_images: 5,
      url_expiry_hint_expired_images: 2,
      url_expiry_hint_near_images: 1,
      url_expiry_hint_later_images: 2,
      url_expiry_hint_unknown_images: 0,
      inline_images: 1,
      provider_id_images: 1,
    });
    expect(JSON.stringify(messages)).toBe(before);
    expect(JSON.stringify(counts)).not.toMatch(
      /private|20261107|Signature|https:/,
    );
  });

  it("leaves unsupported, ambiguous or invalid expiry hints unknown", () => {
    const base =
      "https://private.test/image?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=20261107T085500Z&X-Amz-Expires=600";
    const urls = [
      "https://private.test/unsigned",
      "https://[invalid",
      base + "&X-Amz-Date=20261107T085500Z",
      base + "&X-Amz-Expires=600",
      base + "&X-Amz-Algorithm=AWS4-HMAC-SHA256",
      base.replace("AWS4-HMAC-SHA256", "unsupported"),
      base.replace("20261107T085500Z", "20260230T085500Z"),
      base.replace("20261107T085500Z", "20261107T090001Z"),
      base.replace("Expires=600", "Expires=0"),
      base.replace("Expires=600", "Expires=604801"),
      base.replace("Expires=600", "Expires=1.5"),
      base + "&private=" + "x".repeat(8192),
    ];
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: urls.map((image) => ({ type: "image", image })),
      },
    ];
    const counts = getProviderRequestMediaCounts(
      messages,
      Date.UTC(2026, 10, 7, 9),
    );
    expect(counts).toMatchObject({
      url_images: urls.length,
      url_expiry_hint_unknown_images: urls.length,
      url_expiry_hint_expired_images: 0,
      url_expiry_hint_near_images: 0,
      url_expiry_hint_later_images: 0,
    });
    expect(Object.values(counts).every(Number.isSafeInteger)).toBe(true);
    expect(JSON.stringify(counts)).not.toMatch(/private|Signature|https:/);
  });
});
