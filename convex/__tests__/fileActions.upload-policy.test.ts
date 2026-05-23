import {
  describe,
  it,
  expect,
  jest,
  beforeEach,
  afterEach,
} from "@jest/globals";

jest.mock("../_generated/server", () => ({
  action: jest.fn((config: any) => config),
}));

jest.mock("convex/values", () => ({
  v: {
    id: jest.fn(() => "id"),
    string: jest.fn(() => "string"),
    number: jest.fn(() => "number"),
    boolean: jest.fn(() => "boolean"),
    optional: jest.fn(() => "optional"),
    object: jest.fn(() => "object"),
    union: jest.fn(() => "union"),
    literal: jest.fn(() => "literal"),
  },
  ConvexError: class ConvexError extends Error {
    data: unknown;
    constructor(data: unknown) {
      super(
        typeof data === "string" ? data : (data as { message: string }).message,
      );
      this.data = data;
      this.name = "ConvexError";
    }
  },
}));

jest.mock("../_generated/api", () => ({
  internal: {
    fileStorage: {
      saveFileToDb: "internal.fileStorage.saveFileToDb",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));

jest.mock("../s3Utils", () => ({
  generateS3DownloadUrl: jest.fn(),
}));

jest.mock("pdfjs-serverless", () => ({
  getDocument: jest.fn(),
}));

jest.mock("isbinaryfile", () => ({
  isBinaryFile: jest.fn(),
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

describe("fileActions saveFile upload policy", () => {
  const originalFetch = global.fetch;
  const makeCtx = () =>
    ({
      auth: {
        getUserIdentity: jest.fn().mockResolvedValue({
          subject: "user123",
          entitlements: ["pro-plan"],
        }),
      },
      scheduler: {
        runAfter: jest.fn().mockResolvedValue(undefined),
      },
      storage: {
        delete: jest.fn().mockResolvedValue(undefined),
        getUrl: jest.fn().mockResolvedValue("https://storage.example/file"),
      },
      runMutation: jest.fn().mockResolvedValue("file_123"),
    }) as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    global.fetch = jest.fn() as any;

    const { generateS3DownloadUrl } = await import("../s3Utils");
    (generateS3DownloadUrl as jest.Mock).mockResolvedValue(
      "https://s3.example/download",
    );
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("rejects Ask files above the backend file cap and cleans up S3", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/large.bin",
        name: "large.bin",
        mediaType: "application/octet-stream",
        size: 21 * 1024 * 1024,
        mode: "ask",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "FILE_SIZE_EXCEEDED" }),
    });

    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "internal.s3Cleanup.deleteS3ObjectAction",
      { s3Key: "users/user123/large.bin" },
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("rejects Ask images above the provider image cap", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/large.png",
        name: "large.png",
        mediaType: "image/png",
        size: 6 * 1024 * 1024,
        mode: "ask",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "IMAGE_SIZE_EXCEEDED" }),
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("accepts oversized Agent files as sandbox-only metadata without parsing", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    const result = await saveFile.handler(ctx, {
      s3Key: "users/user123/archive.zip",
      name: "archive.zip",
      mediaType: "application/zip",
      size: 25 * 1024 * 1024,
      mode: "agent",
    });

    expect(result).toEqual({
      url: "https://s3.example/download",
      fileId: "file_123",
      tokens: 0,
    });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({
        s3Key: "users/user123/archive.zip",
        size: 25 * 1024 * 1024,
        fileTokenSize: 0,
        content: undefined,
      }),
    );
  });

  it("saves small Agent files as metadata-only attachments too", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await saveFile.handler(ctx, {
      s3Key: "users/user123/notes.txt",
      name: "notes.txt",
      mediaType: "text/plain",
      size: 1024,
      mode: "agent",
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({
        name: "notes.txt",
        fileTokenSize: 0,
        content: undefined,
      }),
    );
  });

  it("accepts oversized Agent images as sandbox-only metadata without parsing", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await saveFile.handler(ctx, {
      s3Key: "users/user123/large.png",
      name: "large.png",
      mediaType: "image/png",
      size: 8 * 1024 * 1024,
      mode: "agent",
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({
        name: "large.png",
        fileTokenSize: 0,
        content: undefined,
      }),
    );
  });

  it("rejects Agent files above the sandbox staging cap", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/huge.bin",
        name: "huge.bin",
        mediaType: "application/octet-stream",
        size: 251 * 1024 * 1024,
        mode: "agent",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "FILE_SIZE_EXCEEDED" }),
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });
});
