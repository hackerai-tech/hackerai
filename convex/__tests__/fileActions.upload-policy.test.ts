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
  getS3ObjectSizeBytes: jest.fn(),
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

describe("file upload rate limit config", () => {
  it("uses a generous Pro default for cloud uploads", async () => {
    const { getFileUploadRateLimitConfig } = await import("../fileActions");

    expect(getFileUploadRateLimitConfig([])).toEqual({
      tier: "pro",
      limit: 400,
      window: "5 h",
    });
  });

  it("scales cloud upload quotas by paid entitlement", async () => {
    const { getFileUploadRateLimitConfig } = await import("../fileActions");

    expect(getFileUploadRateLimitConfig(["pro-monthly-plan"])).toEqual({
      tier: "pro",
      limit: 400,
      window: "5 h",
    });
    expect(getFileUploadRateLimitConfig(["pro-plus-plan"])).toEqual({
      tier: "pro-plus",
      limit: 800,
      window: "5 h",
    });
    expect(getFileUploadRateLimitConfig(["team-plan"])).toEqual({
      tier: "team",
      limit: 800,
      window: "5 h",
    });
    expect(getFileUploadRateLimitConfig(["ultra-yearly-plan"])).toEqual({
      tier: "ultra",
      limit: 1600,
      window: "5 h",
    });
  });

  it("does not tier up on partial entitlement matches", async () => {
    const { getFileUploadRateLimitConfig } = await import("../fileActions");

    expect(
      getFileUploadRateLimitConfig([
        "not-ultra-plan",
        "team-preview-feature",
        "pro-plus-trial-expired",
      ]),
    ).toEqual({
      tier: "pro",
      limit: 400,
      window: "5 h",
    });
  });
});

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
      runQuery: jest.fn(),
      runMutation: jest.fn().mockResolvedValue("file_123"),
    }) as any;

  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    global.fetch = jest.fn() as any;

    const { generateS3DownloadUrl, getS3ObjectSizeBytes } =
      await import("../s3Utils");
    (generateS3DownloadUrl as jest.Mock).mockResolvedValue(
      "https://s3.example/download",
    );
    (getS3ObjectSizeBytes as jest.Mock).mockImplementation(
      async (s3Key: string) => {
        if (s3Key.includes("large.bin")) return 21 * 1024 * 1024;
        if (s3Key.includes("large.png")) return 8 * 1024 * 1024;
        if (s3Key.includes("archive.zip")) return 25 * 1024 * 1024;
        if (s3Key.includes("huge.bin")) return 251 * 1024 * 1024;
        return 1024;
      },
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

  it("cleans up S3 when final reservation mutation detects a size mismatch", async () => {
    const { saveFile } = await import("../fileActions");
    const { ConvexError } = await import("convex/values");
    const ctx = makeCtx();
    ctx.runMutation.mockRejectedValueOnce(
      new ConvexError({
        code: "FILE_SIZE_MISMATCH",
        message: "Uploaded file size does not match reserved size.",
      }),
    );

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/notes.txt",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 512,
        mode: "agent",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "FILE_SIZE_MISMATCH" }),
    });

    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "internal.s3Cleanup.deleteS3ObjectAction",
      { s3Key: "users/user123/notes.txt" },
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({
        s3Key: "users/user123/notes.txt",
        size: 1024,
      }),
    );
  });

  it("rejects cross-user S3 keys without deleting the object", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/victim/notes.txt",
        name: "notes.txt",
        mediaType: "text/plain",
        size: 1024,
        mode: "ask",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "UNAUTHORIZED_UPLOAD_RESERVATION",
      }),
    });

    expect(ctx.scheduler.runAfter).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("cleans up user-scoped S3 objects when final reservation is missing", async () => {
    const { saveFile } = await import("../fileActions");
    const { ConvexError } = await import("convex/values");
    const ctx = makeCtx();
    ctx.runMutation.mockRejectedValueOnce(
      new ConvexError({
        code: "MISSING_UPLOAD_RESERVATION",
        message: "S3 uploads must have an existing upload reservation.",
      }),
    );

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/orphan.txt",
        name: "orphan.txt",
        mediaType: "text/plain",
        size: 1024,
        mode: "agent",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "MISSING_UPLOAD_RESERVATION" }),
    });

    expect(ctx.scheduler.runAfter).toHaveBeenCalledWith(
      0,
      "internal.s3Cleanup.deleteS3ObjectAction",
      { s3Key: "users/user123/orphan.txt" },
    );
    expect(global.fetch).not.toHaveBeenCalled();
    expect(ctx.runQuery).not.toHaveBeenCalled();
    expect(ctx.runMutation).toHaveBeenCalledWith(
      "internal.fileStorage.saveFileToDb",
      expect.objectContaining({ s3Key: "users/user123/orphan.txt" }),
    );
  });

  it("rejects uploads without an S3 key", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();

    await expect(
      saveFile.handler(ctx, {
        name: "large.bin",
        mediaType: "application/octet-stream",
        size: 1024,
        mode: "ask",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({
        code: "INVALID_STORAGE_ARGS",
      }),
    });

    expect(ctx.runQuery).not.toHaveBeenCalled();
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

  it("rejects invalid Ask image uploads declared with a media-type alias", async () => {
    const { saveFile } = await import("../fileActions");
    const ctx = makeCtx();
    global.fetch = jest.fn(async () => ({
      ok: true,
      blob: async () => ({
        arrayBuffer: async () => new TextEncoder().encode("not a jpeg").buffer,
      }),
    })) as any;

    await expect(
      saveFile.handler(ctx, {
        s3Key: "users/user123/broken.jpg",
        name: "broken.jpg",
        mediaType: "image/jpg",
        size: 1024,
        mode: "ask",
      }),
    ).rejects.toMatchObject({
      data: expect.objectContaining({ code: "INVALID_IMAGE_BYTES" }),
    });

    expect(global.fetch).toHaveBeenCalledWith("https://s3.example/download");
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
