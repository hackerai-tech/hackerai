import type { ModelMessage } from "ai";
import { exceedsAbliterationImageLimit } from "../abliteration-media";

const attachments = (count: number): ModelMessage[] => [
  {
    role: "user",
    content: Array.from({ length: count }, () => ({
      type: "image" as const,
      image: "https://example.test/image.png",
    })),
  },
];

describe("Abliteration request image budget", () => {
  it("allows four images and rejects the observed nine-image request", () => {
    expect(exceedsAbliterationImageLimit(attachments(4))).toBe(false);
    expect(exceedsAbliterationImageLimit(attachments(9))).toBe(true);
  });

  it.each(["image-data", "image-url", "file-data", "file-url"])(
    "counts %s tool images with attachments across the request",
    (type) => {
      const messages = [
        ...attachments(4),
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "view-1",
              toolName: "file",
              output: {
                type: "content",
                value: [
                  {
                    type,
                    data: "test",
                    url: "https://example.test/image.png",
                    mediaType: "image/png",
                  },
                ],
              },
            },
          ],
        },
      ] as ModelMessage[];
      expect(exceedsAbliterationImageLimit(messages)).toBe(true);
    },
  );

  it("does not count text or non-image files as images", () => {
    const messages: ModelMessage[] = [
      ...attachments(4),
      {
        role: "user",
        content: [
          { type: "text", text: "image-data" },
          {
            type: "file",
            data: "test",
            mediaType: "application/pdf",
          },
        ],
      },
    ];
    expect(exceedsAbliterationImageLimit(messages)).toBe(false);
  });
});
