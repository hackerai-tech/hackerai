jest.mock("server-only", () => ({}));

import {
  describeImageAttachmentsWithAuxiliaryVision,
  describeImageWithAuxiliaryVision,
  type AuxiliaryVisionModelRunner,
} from "@/lib/chat/auxiliary-vision";

describe("auxiliary vision", () => {
  beforeEach(() => {
    jest.spyOn(console, "info").mockImplementation(() => {});
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("prefixes sandbox base64, records exposure and cost, and returns text", async () => {
    const modelRunner = jest.fn(async () => ({
      text: "  A terminal shows an exact 403 error.  ",
      usage: {
        inputTokens: 120,
        outputTokens: 12,
        raw: { cost: 0.004 },
      },
    })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;
    const onExposure = jest.fn();
    const onCost = jest.fn();

    const result = await describeImageWithAuxiliaryVision({
      image: "aW1hZ2U=",
      mediaType: "image/png",
      filename: "screen.png",
      source: "file_view",
      onExposure,
      onCost,
      modelRunner,
    });

    expect(modelRunner).toHaveBeenCalledWith(
      expect.objectContaining({
        image: "data:image/png;base64,aW1hZ2U=",
        mediaType: "image/png",
        filename: "screen.png",
        abortSignal: expect.any(AbortSignal),
      }),
    );
    expect(onExposure).toHaveBeenCalledWith("file_view");
    expect(onCost).toHaveBeenCalledWith(0.004);
    expect(result).toMatchObject({
      description: "A terminal shows an exact 403 error.",
      inputTokens: 120,
      outputTokens: 12,
      costDollars: 0.004,
    });
  });

  it("replaces image files with untrusted descriptions and keeps other parts", async () => {
    const modelRunner = jest.fn(async () => ({
      text: "Visible login form with a red invalid-password warning.",
    })) as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    const messages = await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            { type: "text", text: "What failed?" },
            {
              type: "file",
              mediaType: "image/png",
              filename: 'login"screen.png',
              url: "https://files.example/image.png",
            },
            {
              type: "file",
              mediaType: "application/pdf",
              filename: "report.pdf",
              url: "data:application/pdf;base64,cGRm",
            },
          ],
        },
      ],
      modelRunner,
    });

    expect(messages[0].parts).toEqual([
      { type: "text", text: "What failed?" },
      {
        type: "text",
        text: '<image_description filename="login&quot;screen.png" trust="untrusted">\nVisible login form with a red invalid-password warning.\n</image_description>',
      },
      expect.objectContaining({
        type: "file",
        mediaType: "application/pdf",
      }),
    ]);
  });

  it("reuses matching owned-file descriptions without another model call", async () => {
    const modelRunner =
      jest.fn() as jest.MockedFunction<AuxiliaryVisionModelRunner>;

    const messages = await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              fileId: "file-1",
              mediaType: "image/png",
              filename: "cached.png",
              url: "https://files.example/image.png",
              auxiliaryVisionDescription: "Cached & exact <screen> text",
              auxiliaryVisionModel: "google/gemini-3.6-flash",
            } as never,
          ],
        },
      ],
      modelRunner,
    });

    expect(modelRunner).not.toHaveBeenCalled();
    expect(messages[0].parts[0]).toEqual({
      type: "text",
      text: '<image_description filename="cached.png" trust="untrusted">\nCached &amp; exact &lt;screen&gt; text\n</image_description>',
    });
  });

  it("persists a new owned-file description for later turns", async () => {
    const cacheDescription = jest.fn(async () => undefined);
    await describeImageAttachmentsWithAuxiliaryVision({
      messages: [
        {
          id: "message-1",
          role: "user",
          parts: [
            {
              type: "file",
              fileId: "file-1",
              mediaType: "image/png",
              filename: "new.png",
              url: "https://files.example/image.png",
            } as never,
          ],
        },
      ],
      userId: "user-1",
      cacheDescription,
      modelRunner: async () => ({ text: "New description" }),
    });

    expect(cacheDescription).toHaveBeenCalledWith({
      userId: "user-1",
      fileId: "file-1",
      description: "New description",
      model: "google/gemini-3.6-flash",
    });
  });

  it("fails explicitly when the auxiliary model returns no description", async () => {
    await expect(
      describeImageWithAuxiliaryVision({
        image: "data:image/png;base64,aW1hZ2U=",
        mediaType: "image/png",
        source: "attachment",
        modelRunner: async () => ({ text: "   " }),
      }),
    ).rejects.toThrow("empty description");
  });
});
