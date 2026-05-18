jest.mock("server-only", () => ({}), { virtual: true });

jest.mock("@/convex/s3Utils", () => ({
  generateS3UploadUrl: jest.fn(),
}));

jest.mock("@/lib/db/convex-client", () => ({
  getConvexClient: jest.fn(),
}));

import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import {
  MAX_FILE_SIZE_BYTES,
  MAX_GENERATED_FILE_SIZE_BYTES,
} from "@/lib/constants/s3";
import { uploadSandboxFileToConvex } from "../sandbox-file-uploader";

const mockGenerateS3UploadUrl = generateS3UploadUrl as jest.MockedFunction<
  typeof generateS3UploadUrl
>;
const mockGetConvexClient = getConvexClient as jest.MockedFunction<
  typeof getConvexClient
>;
let mockConvexAction: jest.Mock;
let consoleWarnSpy: jest.SpyInstance;
let consoleErrorSpy: jest.SpyInstance;

function makeSandbox(size: number, e2b = false) {
  return {
    ...(e2b ? {} : { sandboxKind: "centrifugo" as const }),
    commands: {
      run: jest.fn(async (command: string) => {
        if (command.startsWith("stat ")) {
          return { stdout: String(size), stderr: "", exitCode: 0 };
        }
        if (command.includes("curl -fsSL -X PUT")) {
          return { stdout: "", stderr: "", exitCode: 0 };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      }),
    },
    files: {
      uploadToUrl: jest.fn(async () => undefined),
    },
    downloadUrl: jest.fn(async () => "https://sandbox.example/file"),
  };
}

describe("uploadSandboxFileToConvex", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    consoleWarnSpy = jest
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    consoleErrorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://convex.example";
    process.env.CONVEX_SERVICE_ROLE_KEY = "service-key";
    mockGenerateS3UploadUrl.mockResolvedValue({
      uploadUrl: "https://s3.example/upload",
      s3Key: "users/u1/file.txt",
    });
    mockConvexAction = jest.fn(async () => ({
      url: "https://s3.example/download",
      fileId: "file_123",
      tokens: 0,
    }));
    mockGetConvexClient.mockReturnValue({
      action: mockConvexAction,
    } as any);
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    consoleErrorSpy.mockRestore();
  });

  test("rejects oversized Centrifugo files before uploading to S3", async () => {
    const sandbox = makeSandbox(MAX_GENERATED_FILE_SIZE_BYTES + 1);

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/large.tar.gz",
      }),
    ).rejects.toThrow(/exceeds the maximum generated file size limit/);

    expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    expect(mockGetConvexClient).not.toHaveBeenCalled();
    expect(mockConvexAction).not.toHaveBeenCalled();
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"sandbox_generated_file_too_large"'),
    );
  });

  test("rejects oversized E2B files before uploading to S3", async () => {
    const sandbox = makeSandbox(MAX_GENERATED_FILE_SIZE_BYTES + 1, true);

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/large.tar.gz",
      }),
    ).rejects.toThrow(/exceeds the maximum generated file size limit/);

    expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
    expect(sandbox.downloadUrl).not.toHaveBeenCalled();
    expect(mockGenerateS3UploadUrl).not.toHaveBeenCalled();
    expect(mockGetConvexClient).not.toHaveBeenCalled();
  });

  test("allows generated artifacts above the user upload limit", async () => {
    const sandbox = makeSandbox(MAX_FILE_SIZE_BYTES + 1);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/archive.tar.gz",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalled();
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "archive.tar.gz",
        size: MAX_FILE_SIZE_BYTES + 1,
      }),
    );
  });

  test("uploads allowed Centrifugo files using the preflight size", async () => {
    const sandbox = makeSandbox(1234);

    const saved = await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/report.txt",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalledWith(
      "/home/user/report.txt",
      "https://s3.example/upload",
      "application/octet-stream",
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "report.txt",
        size: 1234,
        s3Key: "users/u1/file.txt",
      }),
    );
    expect(saved).toMatchObject({
      name: "report.txt",
      s3Key: "users/u1/file.txt",
    });
  });

  test("falls back to command upload when native Centrifugo upload fails", async () => {
    const sandbox = makeSandbox(1234);
    sandbox.files.uploadToUrl.mockRejectedValueOnce(new Error("exit status 1"));

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/preview.png",
      mediaType: "image/png",
    });

    expect(sandbox.files.uploadToUrl).toHaveBeenCalledWith(
      "/home/user/preview.png",
      "https://s3.example/upload",
      "image/png",
    );
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("curl -fsSL -X PUT -H 'Content-Type: image/png'"),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "preview.png",
        size: 1234,
      }),
    );
  });

  test("reports command upload stderr instead of a bare exit status", async () => {
    const sandbox = makeSandbox(1234, true);
    (sandbox.commands.run as jest.Mock).mockImplementation(
      async (command: string) => {
        if (command.startsWith("stat ")) {
          return { stdout: "1234", stderr: "", exitCode: 0 };
        }
        if (command.includes("curl -fsSL -X PUT")) {
          return {
            stdout: "\n__HACKERAI_UPLOAD_EXIT_CODE__:56\n",
            stderr: "curl: (56) response ended early",
            exitCode: 0,
          };
        }
        return { stdout: "", stderr: "unexpected command", exitCode: 1 };
      },
    );

    await expect(
      uploadSandboxFileToConvex({
        sandbox: sandbox as any,
        userId: "u1",
        fullPath: "/home/user/chart-page-1.png",
        mediaType: "image/png",
      }),
    ).rejects.toThrow(/curl: \(56\) response ended early/);
  });

  test("derives the file name from Windows-style paths", async () => {
    const sandbox = makeSandbox(1234);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "C:\\Users\\user\\report.txt",
    });

    expect(mockGenerateS3UploadUrl).toHaveBeenCalledWith(
      "report.txt",
      "application/octet-stream",
      "u1",
    );
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "report.txt",
      }),
    );
  });

  test("uploads allowed E2B files from the sandbox without downloading into memory", async () => {
    const sandbox = makeSandbox(4321, true);

    await uploadSandboxFileToConvex({
      sandbox: sandbox as any,
      userId: "u1",
      fullPath: "/home/user/archive.tar.gz",
    });

    expect(sandbox.downloadUrl).not.toHaveBeenCalled();
    expect(sandbox.files.uploadToUrl).not.toHaveBeenCalled();
    expect(sandbox.commands.run).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "curl -fsSL -X PUT -H 'Content-Type: application/octet-stream'",
      ),
      expect.objectContaining({
        timeoutMs: expect.any(Number),
      }),
    );
    const uploadCommand = (sandbox.commands.run as jest.Mock).mock.calls[1][0];
    expect(uploadCommand).toContain("'https://s3.example/upload'");
    expect(uploadCommand).not.toContain("UPLOAD_URL");
    expect(mockConvexAction).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        name: "archive.tar.gz",
        size: 4321,
      }),
    );
  });
});
