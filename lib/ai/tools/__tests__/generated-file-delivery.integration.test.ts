/** Real local file/HTTP transfers; Convex persistence and URL signing are in-memory fixtures. */
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/convex/_generated/server", () => ({
  action: (config: unknown) => config,
}));
jest.mock("@/convex/s3Utils", () => ({
  generateS3UploadUrl: jest.fn(),
  generateS3DownloadUrl: jest.fn(),
  getS3ObjectSizeBytes: jest.fn(),
  getStoredS3Location: jest.fn(),
}));
jest.mock("@/convex/lib/utils", () => ({ validateServiceKey: jest.fn() }));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));
jest.mock("@/lib/posthog/server", () => ({ phLogger: { event: jest.fn() } }));
jest.mock("pdfjs-serverless", () => ({ getDocument: jest.fn() }));
jest.mock("isbinaryfile", () => ({ isBinaryFile: jest.fn() }));

import { createServer, request, type Server } from "node:http";
import { mkdtemp, readFile, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createGetTerminalFiles } from "../get-terminal-files";
import { getSandboxUploadedFileUrl } from "../utils/sandbox-file-uploader";
import { LocalCommandRelayUnsubscribedError } from "../utils/local-sandbox-errors";
import { saveSandboxGeneratedFile } from "@/convex/fileActions";
import { getConvexClient } from "@/lib/db/convex-client";
import * as storage from "@/convex/s3Utils";
import type { ToolContext } from "@/types";

const exec = promisify(execFile);
function transfer(url: string, method = "GET", body?: Buffer) {
  return new Promise<{ status: number; body: Buffer; size: number }>(
    (resolve, reject) => {
      const req = request(url, { method }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks),
            size: Number(res.headers["content-length"]),
          }),
        );
      });
      req.on("error", reject);
      req.end(body);
    },
  );
}

describe("generated artifact delivery over HTTP", () => {
  let server: Server;
  let baseUrl: string;
  let directory: string;
  let object: Buffer | undefined;
  let file: { s3Key: string } | undefined;
  let generation: number;
  let dropUpload: boolean;
  const key = "users/test-user/report.txt";
  const location = { region: "us-west-2", bucket: "fixture-bucket" };
  const contents = "File delivery acceptance: café, evidence retained.\n";
  let runMutation: jest.Mock;
  let cleanup: jest.Mock;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "generated-delivery-"));
    server = createServer((req, res) => {
      if (req.method === "PUT") {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        req.on("end", () => {
          if (!dropUpload) object = Buffer.concat(chunks);
          res.writeHead(200).end();
        });
        return;
      }
      if (req.url?.includes("expired")) {
        res.writeHead(403).end();
        return;
      }
      if (!object) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, {
        "Content-Length": object.length,
        "Content-Type": "text/plain",
      });
      res.end(req.method === "HEAD" ? undefined : object);
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    object = undefined;
    file = undefined;
    generation = 0;
    dropUpload = false;
    process.env.NEXT_PUBLIC_CONVEX_URL = "https://test.convex.cloud";
    process.env.CONVEX_SERVICE_ROLE_KEY = "test-service-key";
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
    jest.mocked(storage.getStoredS3Location).mockReturnValue(location);
    jest.mocked(storage.generateS3UploadUrl).mockResolvedValue({
      uploadUrl: `${baseUrl}/object`,
      s3Key: key,
      storageLocation: location,
    });
    jest
      .mocked(storage.generateS3DownloadUrl)
      .mockImplementation(
        async () => `${baseUrl}/object?generation=${++generation}`,
      );
    jest.mocked(storage.getS3ObjectSizeBytes).mockImplementation(async () => {
      const result = await transfer(`${baseUrl}/object`, "HEAD");
      if (result.status !== 200) throw new Error("Object missing");
      return result.size;
    });
    runMutation = jest.fn(async (_reference, args) => {
      file = args;
      return "file-fixture";
    });
    cleanup = jest.fn();
    const ctx = {
      runMutation,
      runQuery: jest.fn(async () => file ?? null),
      scheduler: { runAfter: cleanup },
    };
    jest.mocked(getConvexClient).mockReturnValue({
      action: jest.fn(async (_reference, args) => {
        if (args.fileIds) {
          // Rehydrate the stable file ID, as after a saved chat is reopened.
          if (!file || args.userId !== "test-user") return [null];
          return [await storage.generateS3DownloadUrl(file.s3Key, location)];
        }
        return (saveSandboxGeneratedFile as any).handler(ctx, args);
      }),
    } as any);
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  async function deliverAfterReconnect(useSymlink = false) {
    const source = join(directory, "report.txt");
    await rm(source, { force: true });
    if (useSymlink) {
      const target = join(directory, "original-report.txt");
      await writeFile(target, contents);
      await symlink(target, source);
    } else {
      await writeFile(source, contents);
    }
    const connected = {
      sandboxKind: "centrifugo",
      getConnectionId: () => "reconnected-same-machine",
      isWindows: () => false,
      commands: {
        run: async (command: string) => ({
          ...(await exec("/bin/sh", ["-c", command])),
          exitCode: 0,
        }),
      },
      files: {
        uploadToUrl: async (path: string, url: string) => {
          const response = await transfer(url, "PUT", await readFile(path));
          if (response.status !== 200) throw new Error("Upload failed");
        },
      },
    };
    const stale = {
      ...connected,
      getConnectionId: () => "stale",
      commands: {
        run: async () => {
          throw new LocalCommandRelayUnsubscribedError("stale");
        },
      },
    };
    const context = {
      userID: "test-user",
      chatId: "chat-fixture",
      assistantMessageId: "message-fixture",
      sandboxManager: {
        getSandbox: jest
          .fn()
          .mockResolvedValueOnce({ sandbox: stale })
          .mockResolvedValue({ sandbox: connected }),
        getSandboxInfo: () => ({ type: "desktop" }),
        recoverLocalConnection: jest.fn(async () => ({ sandbox: connected })),
      },
      backgroundProcessTracker: {
        hasActiveProcessesForFiles: async () => ({
          active: false,
          processes: [],
        }),
      },
      fileAccumulator: { add: jest.fn() },
      writer: { write: jest.fn() },
    } as unknown as ToolContext;
    const tool = createGetTerminalFiles(context);
    const result = await (tool.execute as any)(
      { files: [source] },
      { toolCallId: "delivery-fixture" },
    );
    return { source, context, result };
  }

  it.each([false, true])(
    "reconnects and opens the stored bytes without the source (symlink: %s)",
    async (useSymlink) => {
      const { source, context, result } =
        await deliverAfterReconnect(useSymlink);
      expect(
        context.sandboxManager.recoverLocalConnection,
      ).toHaveBeenCalledWith("stale", "command_relay_unsubscribed");
      expect(result.failedFiles).toEqual([]);
      expect(result.deliveryReceipts[0]).toMatchObject({
        fileId: "file-fixture",
        storageStatus: "stored",
      });
      expect(context.writer.write).toHaveBeenCalledTimes(1);
      expect(storage.getS3ObjectSizeBytes).toHaveBeenCalledWith(key, location);
      expect(runMutation).toHaveBeenCalledTimes(1);
      await rm(source);
      expect((await transfer(`${baseUrl}/object?expired`)).status).toBe(403);
      const url = await getSandboxUploadedFileUrl({
        fileId: "file-fixture" as never,
        userId: "test-user",
      });
      expect(url).toContain("generation=2");
      const downloaded = await transfer(url!);
      expect(downloaded.status).toBe(200);
      const destination = join(directory, "downloaded-report.txt");
      await writeFile(destination, downloaded.body);
      expect(await readFile(destination, "utf8")).toBe(contents);
    },
  );

  it("does not emit a file card or receipt when an upload reports success but stores no object", async () => {
    dropUpload = true;
    const { context, result } = await deliverAfterReconnect();
    expect(result.files).toEqual([]);
    expect(result.deliveryReceipts).toEqual([]);
    expect(result.failedFiles[0].reason).toContain(
      "could not be verified in storage",
    );
    expect(context.writer.write).not.toHaveBeenCalled();
    expect(context.fileAccumulator.add).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});
