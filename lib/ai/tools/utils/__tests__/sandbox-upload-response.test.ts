import { execFile, spawn } from "node:child_process";
import { createServer } from "node:http";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildPosixCurlUploadCommand,
  getUploadFailureDiagnostics,
} from "../sandbox-upload-diagnostics";

const run = promisify(execFile);
const posixDescribe = process.platform === "win32" ? describe.skip : describe;

posixDescribe("bounded storage rejection diagnostics through real curl", () => {
  let directory: string;
  let source: string;
  let endpoint: string;
  let requests: Buffer[];
  let status: number;
  let body: string;
  let server: ReturnType<typeof createServer>;
  let holdResponse: boolean;
  let requestReceived: (() => void) | undefined;
  const payload = "quoted ' and literal \\ path; UTF-8 λ\n";

  beforeEach(async () => {
    directory = await mkdtemp(
      path.join(os.tmpdir(), "hackerai-upload-diagnostic-"),
    );
    source = path.join(directory, "report 'literal\\name.txt");
    await writeFile(source, payload);
    requests = [];
    status = 200;
    body = "";
    holdResponse = false;
    requestReceived = undefined;
    server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      requests.push(Buffer.concat(chunks));
      res.writeHead(status, { "Content-Type": "application/xml" });
      if (holdResponse) res.write(body);
      else res.end(body);
      requestReceived?.();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/upload`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  });

  async function upload(tempDirectory = directory, file = source) {
    return run(
      "/bin/bash",
      ["-c", buildPosixCurlUploadCommand(file, endpoint, "text/plain")],
      {
        env: { PATH: "/usr/bin:/bin", TMPDIR: tempDirectory },
        timeout: 5000,
      },
    ).then(
      (result) => ({ ...result, code: 0 }),
      (error: { stdout: string; stderr: string; code: number }) => error,
    );
  }

  it.each([
    ["SignatureDoesNotMatch", "SignatureDoesNotMatch"],
    ["AccessDenied", "AccessDenied"],
    ["ExpiredToken", "ExpiredToken"],
    ["private-unrecognized-code", null],
  ] as const)(
    "retains only the allowlisted code for %s",
    async (code, expected) => {
      status = 403;
      body = `<Error><Code>${code}</Code><Message>PRIVATE response body</Message><CanonicalRequest>PRIVATE signing material</CanonicalRequest></Error>`;
      const result = await upload();
      expect(result.code).toBe(22);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toMatch(
        /PRIVATE|CanonicalRequest|private-unrecognized-code/,
      );
      expect(
        getUploadFailureDiagnostics(
          endpoint,
          new Error(`Failed to upload file: ${result.stderr}`),
        ),
      ).toMatchObject({
        upload_reported_http_status: 403,
        upload_reported_storage_code: expected,
        upload_storage_diagnostic_present: true,
      });
      expect(requests.map((bytes) => bytes.toString())).toEqual([payload]);
      expect(await readdir(directory)).toEqual([path.basename(source)]);
      expect(await readFile(source, "utf8")).toBe(payload);
    },
  );

  it("keeps non-storage proxy responses private and leaves their cause unknown", async () => {
    status = 403;
    body = "<html>PRIVATE proxy rejection</html>";
    const result = await upload();
    expect(result.code).toBe(22);
    expect(result.stderr).not.toContain("PRIVATE");
    expect(getUploadFailureDiagnostics(endpoint, result.stderr)).toMatchObject({
      upload_reported_http_status: 403,
      upload_reported_storage_code: null,
      upload_storage_diagnostic_present: true,
    });
  });

  it("bounds error inspection even when the response is large", async () => {
    status = 403;
    body = "PRIVATE".repeat(2000) + "<Code>AccessDenied</Code>";
    const result = await upload();
    expect(result.code).toBe(22);
    expect(result.stderr).not.toMatch(/PRIVATE|AccessDenied/);
    expect(getUploadFailureDiagnostics(endpoint, result.stderr)).toMatchObject({
      upload_reported_storage_code: null,
      upload_storage_diagnostic_present: true,
    });
    expect(await readdir(directory)).toEqual([path.basename(source)]);
  });

  it.each([false, true])(
    "preserves exact successful upload bytes with diagnostic setup unavailable=%s",
    async (unavailable) => {
      const result = await upload(
        unavailable ? path.join(directory, "missing") : directory,
      );
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(requests.map((bytes) => bytes.toString())).toEqual([payload]);
      expect(await readdir(directory)).toEqual([path.basename(source)]);
    },
  );

  it("preserves curl's local read failure and cleans up diagnostics", async () => {
    const result = await upload(directory, path.join(directory, "absent"));
    expect(result.code).toBe(26);
    expect(
      getUploadFailureDiagnostics(endpoint, result.stderr)
        .upload_reported_http_status,
    ).toBeNull();
    expect(await readdir(directory)).toEqual([path.basename(source)]);
  });

  it.each([200, 403])(
    "preserves uploads with confined Snap curl (HTTP %s) without a response file",
    async (httpStatus) => {
      const bin = path.join(directory, "snap", "bin");
      await mkdir(bin, { recursive: true });
      // Model a curl that cannot write the shell's response path. This is a
      // boundary fixture, not a real Snap installation on this POSIX host.
      await writeFile(
        path.join(bin, "curl"),
        '#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "-o" ]; then exit 23; fi\ndone\nexec /usr/bin/curl "$@"\n',
        { mode: 0o700 },
      );
      status = httpStatus;
      body = httpStatus === 403 ? "<Error>PRIVATE storage body</Error>" : "";
      const before = (await readdir(directory)).sort();
      const result = await run(
        "/bin/bash",
        ["-c", buildPosixCurlUploadCommand(source, endpoint, "text/plain")],
        {
          env: { PATH: `${bin}:/usr/bin:/bin`, TMPDIR: directory },
          timeout: 5000,
        },
      ).then(
        (result) => ({ ...result, code: 0 }),
        (error: { stdout: string; stderr: string; code: number }) => error,
      );
      expect(result.code).toBe(httpStatus === 403 ? 22 : 0);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain("PRIVATE");
      expect(
        getUploadFailureDiagnostics(endpoint, result.stderr),
      ).toMatchObject({
        upload_reported_http_status: httpStatus === 403 ? 403 : null,
        upload_storage_diagnostic_present: false,
      });
      expect(requests.map((bytes) => bytes.toString())).toEqual([payload]);
      expect((await readdir(directory)).sort()).toEqual(before);
    },
  );

  it("removes the private response file when the owned upload is cancelled", async () => {
    status = 403;
    body = "PRIVATE partial response";
    holdResponse = true;
    const received = new Promise<void>((resolve) => {
      requestReceived = resolve;
    });
    const child = spawn(
      "/bin/bash",
      ["-c", buildPosixCurlUploadCommand(source, endpoint, "text/plain")],
      {
        env: { PATH: "/usr/bin:/bin", TMPDIR: directory },
        detached: true,
        // Keep pipes open until the shell descendants finish their EXIT trap.
        // Ignored stdio lets the parent close before that cleanup completes.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    try {
      await Promise.race([
        received,
        closed.then(() => {
          throw new Error("Upload exited before the response");
        }),
      ]);
      expect(
        (await readdir(directory)).some((name) =>
          name.startsWith("hackerai-upload-response."),
        ),
      ).toBe(true);
      // Signal only this test-owned process group, matching command cancellation.
      process.kill(-child.pid!, "SIGTERM");
      await closed;
      expect(await readdir(directory)).toEqual([path.basename(source)]);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        process.kill(-child.pid!, "SIGKILL");
        await closed;
      }
    }
  });
});
