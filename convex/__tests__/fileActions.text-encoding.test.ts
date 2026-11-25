/**
 * @jest-environment node
 */
import { describe, it, expect, jest, beforeEach } from "@jest/globals";

jest.mock("../lib/serviceFunctions", () => ({
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
    null: jest.fn(() => "null"),
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
      getFileByS3Key: "internal.fileStorage.getFileByS3Key",
    },
    s3Cleanup: {
      deleteS3ObjectAction: "internal.s3Cleanup.deleteS3ObjectAction",
    },
  },
}));

jest.mock("../s3Utils", () => ({
  generateS3DownloadUrl: jest.fn(),
  getS3ObjectMetadataFailure: jest.fn(),
  getS3ObjectSizeBytes: jest.fn(),
  getStoredS3Location: jest.fn(),
}));

jest.mock("pdfjs-serverless", () => ({
  getDocument: jest.fn(),
}));

jest.mock("isbinaryfile", () => ({
  isBinaryFile: jest.fn(async () => false),
}));

jest.mock("../lib/utils", () => ({
  validateServiceKey: jest.fn(),
}));

const TEXT = "Name    Status\r\nsmb     open\r\n";

const utf16le = (text: string) =>
  new Uint8Array([0xff, 0xfe, ...Buffer.from(text, "utf16le")]);

const utf16be = (text: string) => {
  const le = Buffer.from(text, "utf16le");
  const be = new Uint8Array(le.length);
  for (let i = 0; i < le.length; i += 2) {
    be[i] = le[i + 1];
    be[i + 1] = le[i];
  }
  return new Uint8Array([0xfe, 0xff, ...be]);
};

const utf8WithBom = (text: string) =>
  new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, "utf8")]);

const saveAskFile = async (
  bytes: Uint8Array,
  name: string,
  mediaType: string,
) => {
  const { saveFile } = await import("../fileActions");
  const ctx = {
    auth: {
      getUserIdentity: jest.fn(async () => ({
        subject: "user123",
        entitlements: ["pro-plan"],
      })),
    },
    scheduler: { runAfter: jest.fn(async () => undefined) },
    runQuery: jest.fn(async () => ({ user_id: "user123" })),
    runMutation: jest.fn(async () => "file_123"),
  } as any;
  global.fetch = jest.fn(async () => ({
    ok: true,
    blob: async () => new Blob([bytes as Uint8Array<ArrayBuffer>]),
  })) as any;

  await (saveFile as any).handler(ctx, {
    s3Key: `users/user123/${name}`,
    name,
    mediaType,
    size: bytes.length,
    mode: "ask",
  });

  const saveCall = ctx.runMutation.mock.calls.find(
    ([fn]: [string]) => fn === "internal.fileStorage.saveFileToDb",
  );
  return saveCall?.[1].content as string | undefined;
};

describe("Ask text attachments with a byte order mark", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    const { generateS3DownloadUrl, getS3ObjectSizeBytes, getStoredS3Location } =
      await import("../s3Utils");
    (getStoredS3Location as jest.Mock<any>).mockReturnValue(undefined);
    (generateS3DownloadUrl as jest.Mock<any>).mockResolvedValue(
      "https://s3.example/download",
    );
    (getS3ObjectSizeBytes as jest.Mock<any>).mockResolvedValue(1024);
  });

  it.each([
    ["UTF-16LE", utf16le(TEXT)],
    ["UTF-16BE", utf16be(TEXT)],
    ["UTF-8 with BOM", utf8WithBom(TEXT)],
  ])("saves the readable text of a %s .txt file", async (_label, bytes) => {
    await expect(saveAskFile(bytes, "scan.txt", "text/plain")).resolves.toBe(
      TEXT,
    );
  });

  it("saves the readable text of a UTF-16LE file without a known extension", async () => {
    await expect(
      saveAskFile(utf16le(TEXT), "scan.out", "application/octet-stream"),
    ).resolves.toBe(TEXT);
  });

  it("parses a UTF-16LE .json file", async () => {
    await expect(
      saveAskFile(
        utf16le('{"host":"10.0.0.5"}'),
        "hosts.json",
        "application/json",
      ),
    ).resolves.toBe(JSON.stringify({ host: "10.0.0.5" }, null, 2));
  });

  it("reads the cells of a UTF-16LE .csv file", async () => {
    const content = await saveAskFile(
      utf16le("host,port\r\n10.0.0.5,445\r\n"),
      "ports.csv",
      "text/csv",
    );
    expect(content).toContain("10.0.0.5");
    expect(content).not.toContain("\u0000");
  });
});
