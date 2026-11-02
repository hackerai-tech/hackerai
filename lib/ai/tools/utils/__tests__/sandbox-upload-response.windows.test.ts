import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildShellSpawn,
  findGitBash,
  windowsSystemExecutable,
} from "@/packages/local/src/utils";
import {
  buildPosixCurlUploadCommand,
  getUploadFailureDiagnostics,
} from "../sandbox-upload-diagnostics";

const run = promisify(execFile);
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;

windowsDescribe("native Windows curl through Git Bash", () => {
  it.each([
    [200, "", false, false],
    [200, "", false, true],
    [403, "AccessDenied", false, false],
    [403, "SignatureDoesNotMatch", false, false],
    [403, null, true, false],
  ] as const)(
    "preserves HTTP %s, code %s and exact bytes (oversized=%s, legacy=%s)",
    async (status, code, oversized, legacy) => {
      const shell = findGitBash();
      if (!shell)
        throw new Error("Windows upload acceptance requires Git Bash");
      const directory = await mkdtemp(join(tmpdir(), "hackerai-upload-"));
      const source = join(directory, "quoted ' UTF-8.txt");
      const payload = "owned upload UTF-8 λ\n";
      const requests: string[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(Buffer.concat(chunks).toString());
        res.writeHead(status, { "Content-Type": "application/xml" });
        res.end(
          (oversized ? "PRIVATE".repeat(20000) : "") +
            `<Error><Code>${code ?? "AccessDenied"}</Code><Message>PRIVATE body</Message></Error>`,
        );
      });
      try {
        await writeFile(source, payload);
        await new Promise<void>((resolve) =>
          server.listen(0, "127.0.0.1", resolve),
        );
        const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/upload`;
        // Select Windows' own curl, not the MSYS build with its virtual filesystem.
        const curl = windowsSystemExecutable("curl.exe").replaceAll("\\", "/");
        const command = `curl() { ${legacy ? 'if [ "$1" = "--help" ]; then return 0; fi; ' : ""}${quote(curl)} "$@"; }\n${buildPosixCurlUploadCommand(source.replaceAll("\\", "/"), endpoint, "text/plain")}`;
        const spec = buildShellSpawn(shell, "-c", command);
        const result = await run(shell, spec.args, {
          ...spec.options,
          timeout: 10_000,
        }).then(
          (value) => ({ ...value, code: 0 }),
          (error: { stdout: string; stderr: string; code: number }) => error,
        );
        expect(result.code).toBe(status === 403 ? 22 : 0);
        expect(result.stdout).toBe("");
        expect(result.stderr).not.toContain("PRIVATE");
        expect(requests).toEqual([payload]);
        expect(
          getUploadFailureDiagnostics(endpoint, result.stderr),
        ).toMatchObject({
          upload_reported_http_status: status === 403 ? 403 : null,
          upload_reported_storage_code: status === 403 ? code : null,
          upload_storage_diagnostic_present: status === 403,
        });
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
