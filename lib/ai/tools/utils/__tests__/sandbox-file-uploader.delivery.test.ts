/** @jest-environment-options {"customExportConditions":["node","node-addons"]} */
jest.mock("server-only", () => ({}), { virtual: true });
jest.mock("@/convex/s3Utils", () => ({ generateS3UploadUrl: jest.fn() }));
jest.mock("@/lib/db/convex-client", () => ({ getConvexClient: jest.fn() }));

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { generateS3UploadUrl } from "@/convex/s3Utils";
import { getConvexClient } from "@/lib/db/convex-client";
import { CentrifugoSandbox } from "../centrifugo-sandbox";
import { uploadSandboxFileToConvex } from "../sandbox-file-uploader";

// Bypass the repository's SDK mocks: the production SDK must generate the URL.
const { S3Client, PutObjectCommand } = require(
  join(
    dirname(require.resolve("@aws-sdk/client-s3/package.json")),
    "dist-cjs/index.js",
  ),
) as typeof import("@aws-sdk/client-s3");
const { getSignedUrl } = require(
  join(
    dirname(require.resolve("@aws-sdk/s3-request-presigner/package.json")),
    "dist-cjs/index.js",
  ),
) as typeof import("@aws-sdk/s3-request-presigner");
const fixtureSecret = "synthetic-local-sigv4-test-only";
const encode = (value: string) =>
  encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hmac = (key: string | Buffer, value: string) =>
  createHmac("sha256", key).update(value).digest();

// Independent verification of the real SDK's SigV4 request, including observed
// Content-Length. The server never receives real credentials or customer files.
// https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
function validSignature(request: IncomingMessage): boolean {
  const url = new URL(request.url!, `http://${request.headers.host}`);
  const query = url.searchParams;
  const signed = query.get("X-Amz-SignedHeaders")!;
  const scope = query.get("X-Amz-Credential")!.split("/").slice(1);
  const canonicalQuery = [...query.entries()]
    .filter(([key]) => key !== "X-Amz-Signature")
    .map(([key, value]) => [encode(key), encode(value)])
    .sort(([a, av], [b, bv]) =>
      a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0,
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");
  const headers = signed
    .split(";")
    .map(
      (key) =>
        `${key}:${String(request.headers[key] ?? "")
          .trim()
          .replace(/\s+/g, " ")}\n`,
    )
    .join("");
  const canonical = [
    request.method,
    url.pathname,
    canonicalQuery,
    headers,
    signed,
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    query.get("X-Amz-Date"),
    scope.join("/"),
    hash(canonical),
  ].join("\n");
  const key = scope.reduce(
    (key, part) => hmac(key, part),
    Buffer.from(`AWS4${fixtureSecret}`),
  );
  return (
    hmac(key, stringToSign).toString("hex") === query.get("X-Amz-Signature")
  );
}

const posixDescribe = process.platform === "win32" ? describe.skip : describe;
posixDescribe(
  "Desktop delivery through a real shell and SigV4 verifier",
  () => {
    let directory: string;
    let endpoint: string;
    let accepted: Buffer[];
    let statuses: number[];
    let server: ReturnType<typeof createServer>;
    let warnings: jest.SpyInstance;
    let errors: jest.SpyInstance;
    let client: InstanceType<typeof S3Client>;
    const originalUrl = process.env.NEXT_PUBLIC_CONVEX_URL;
    const originalKey = process.env.CONVEX_SERVICE_ROLE_KEY;

    beforeEach(async () => {
      directory = mkdtempSync(join(tmpdir(), "delivery-sigv4-"));
      accepted = [];
      statuses = [];
      warnings = jest
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      errors = jest.spyOn(console, "error").mockImplementation(() => undefined);
      server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk) => chunks.push(chunk));
        request.on("end", () => {
          const valid = validSignature(request);
          statuses.push(valid ? 200 : 403);
          if (valid) accepted.push(Buffer.concat(chunks));
          response.writeHead(valid ? 200 : 403, {
            "Content-Type": "application/xml",
          });
          response.end(
            valid ? "" : "<Error><Code>SignatureDoesNotMatch</Code></Error>",
          );
        });
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      endpoint = `http://127.0.0.1:${address.port}`;
      client = new S3Client({
        endpoint,
        region: "us-east-1",
        forcePathStyle: true,
        requestChecksumCalculation: "WHEN_REQUIRED",
        credentials: { accessKeyId: "fixture", secretAccessKey: fixtureSecret },
      });
      process.env.NEXT_PUBLIC_CONVEX_URL = "https://fixture.invalid";
      process.env.CONVEX_SERVICE_ROLE_KEY = "fixture";
      jest
        .mocked(generateS3UploadUrl)
        .mockImplementation(
          async (_name, contentType, _user, contentLength) => ({
            uploadUrl: await getSignedUrl(
              client,
              new PutObjectCommand({
                Bucket: "fixture",
                Key: "file",
                ContentType: contentType,
                ContentLength: contentLength,
              }),
              { expiresIn: 3600 },
            ),
            s3Key: "fixture",
            storageLocation: { region: "us-east-1", bucket: "fixture" },
          }),
        );
      jest.mocked(getConvexClient).mockReturnValue({
        action: jest.fn(async () => ({
          fileId: "fixture",
          tokens: 0,
          url: "https://fixture.invalid/download",
        })),
      } as any);
    });

    afterEach(async () => {
      client?.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      rmSync(directory, { recursive: true, force: true });
      warnings.mockRestore();
      errors.mockRestore();
      if (originalUrl === undefined) delete process.env.NEXT_PUBLIC_CONVEX_URL;
      else process.env.NEXT_PUBLIC_CONVEX_URL = originalUrl;
      if (originalKey === undefined) delete process.env.CONVEX_SERVICE_ROLE_KEY;
      else process.env.CONVEX_SERVICE_ROLE_KEY = originalKey;
      jest.clearAllMocks();
    });

    function adapter(isDesktop = true) {
      const sandbox = new CentrifugoSandbox(
        "fixture",
        {
          connectionId: "fixture",
          name: "fixture",
          isDesktop,
          capabilities: { commands: true, files: true },
          osInfo: {
            platform: "darwin",
            arch: "arm64",
            release: "fixture",
            hostname: "fixture",
          },
        },
        { wsUrl: "ws://fixture.invalid", tokenSecret: "fixture" },
        directory,
      );
      (sandbox as any).httpClient = "curl";
      // Native transport is substituted by real filesystem metadata; no path
      // transformation here, matching Rust's tokio::fs::metadata contract.
      jest.spyOn(sandbox.files, "stat").mockImplementation(async (path) => ({
        type: "file_stat_result",
        requestId: "fixture",
        path,
        kind: "file",
        sizeBytes: statSync(path).size,
      }));
      jest.spyOn(sandbox.commands, "run").mockImplementation(
        (command) =>
          new Promise((resolve) =>
            execFile(
              "/bin/sh",
              ["-c", command],
              { cwd: directory, timeout: 5000 },
              (error, stdout, stderr) =>
                resolve({
                  stdout,
                  stderr,
                  exitCode: error ? Number(error.code) || 1 : 0,
                }),
            ),
          ),
      );
      return sandbox;
    }

    it("accepts ordinary bytes and independently rejects a signed-length mismatch", async () => {
      const path = join(directory, "ordinary.txt");
      writeFileSync(path, "expected");
      await uploadSandboxFileToConvex({
        sandbox: adapter(),
        userId: "fixture",
        fullPath: path,
      });
      expect(accepted[0]).toEqual(readFileSync(path));
      const mismatched = adapter();
      jest.mocked(mismatched.files.stat).mockResolvedValueOnce({
        type: "file_stat_result",
        requestId: "fixture",
        path,
        kind: "file",
        sizeBytes: 1,
      });
      const failures: unknown[] = [];
      await expect(
        uploadSandboxFileToConvex({
          sandbox: mismatched,
          userId: "fixture",
          fullPath: path,
          onTransferAttemptFailure: (failure) => {
            failures.push(failure);
          },
        }),
      ).rejects.toThrow("403");
      // Preserve the existing native + command fallback; neither may claim
      // that an HTTP rejection delivered the file.
      expect(statuses).toEqual([200, 403, 403]);
      expect(failures).toEqual(
        ["native", "command"].map((kind) =>
          expect.objectContaining({
            transfer_attempt_kind: kind,
            upload_reported_http_status: 403,
            upload_reported_storage_code: "SignatureDoesNotMatch",
            upload_storage_diagnostic_present: true,
          }),
        ),
      );
      expect(getConvexClient().action).toHaveBeenCalledTimes(1);
    });

    it.each(["copy", "write"])(
      "prepares a literal-backslash POSIX filename through %s",
      async (operation) => {
        const source = join(directory, "source.txt");
        const destination = join(directory, "prefix\\report.txt");
        writeFileSync(source, "fixture");
        // This is a file, not the destination's parent directory.
        writeFileSync(join(directory, "prefix"), "preserve");
        const sandbox = adapter(false);
        if (operation === "copy")
          await sandbox.files.copyLocal(source, destination);
        else await sandbox.files.write(destination, "fixture");
        expect(readFileSync(destination, "utf8")).toBe("fixture");
        expect(readFileSync(join(directory, "prefix"), "utf8")).toBe(
          "preserve",
        );
      },
    );

    it.each(["different size", "same size"])(
      "uploads the exact POSIX filename with a backslash when a %s sibling exists",
      async (size) => {
        const path = join(directory, "reports\\result.txt");
        const bytes = Buffer.from("intended artifact");
        writeFileSync(path, bytes);
        mkdirSync(join(directory, "reports"));
        writeFileSync(
          join(directory, "reports/result.txt"),
          size === "same size" ? Buffer.alloc(bytes.length, 88) : "wrong file",
        );
        const failures: unknown[] = [];
        await uploadSandboxFileToConvex({
          sandbox: adapter(),
          userId: "fixture",
          fullPath: path,
          onTransferAttemptFailure: (failure) => {
            failures.push(failure);
          },
        });
        expect(accepted).toEqual([bytes]);
        const saved = jest.mocked(getConvexClient().action).mock.calls[0][1];
        expect(saved).toMatchObject({ name: "reports\\result.txt" });
        expect(statuses).toEqual([200]);
        expect(failures).toEqual([]);
      },
    );
  },
);
