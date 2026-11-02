import { execFile } from "node:child_process";
import { createServer } from "node:https";
import { createSecureContext } from "node:tls";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  buildShellSpawn,
  findGitBash,
  windowsSystemExecutable,
} from "@/packages/local/src/utils";
import {
  buildUploadNetworkProbeCommand,
  parseUploadNetworkProbe,
} from "../sandbox-upload-network-diagnostics";

const run = promisify(execFile);
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const bucket = "qa-bucket.s3.us-east-1.amazonaws.com";
const regional = "s3.us-east-1.amazonaws.com";
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;

windowsDescribe("Windows file upload connectivity probes", () => {
  it.each(["windows-bash", "cmd"] as const)(
    "distinguishes TLS rejection from unsigned HTTP 403 through %s",
    async (shellKind) => {
      const bash = findGitBash();
      if (!bash) throw Error("Git Bash required for Windows acceptance");
      const directory = await mkdtemp(join(tmpdir(), "upload-network-"));
      let server: ReturnType<typeof createServer> | undefined;
      try {
        const certPath = join(directory, "cert.pem");
        const keyPath = join(directory, "key.pem");
        await run(resolve(dirname(bash), "../usr/bin/openssl.exe"), [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          keyPath,
          "-out",
          certPath,
          "-days",
          "1",
          "-subj",
          `/CN=${bucket}`,
          "-addext",
          `subjectAltName=DNS:${bucket},DNS:${regional}`,
        ]);
        const cert = await readFile(certPath);
        const key = await readFile(keyPath);
        const context = createSecureContext({ cert, key });
        let rejectBucket = true;
        const requests: Array<{
          method: string | undefined;
          url: string | undefined;
          bytes: number;
          authorization: unknown;
        }> = [];
        server = createServer(
          {
            cert,
            key,
            SNICallback: (name, callback) =>
              callback(
                rejectBucket && name === bucket
                  ? Error("injected handshake rejection")
                  : null,
                context,
              ),
          },
          async (req, res) => {
            let bytes = 0;
            for await (const chunk of req) bytes += Buffer.byteLength(chunk);
            requests.push({
              method: req.method,
              url: req.url,
              bytes,
              authorization: req.headers.authorization,
            });
            res.writeHead(403);
            res.end();
          },
        );
        await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
        const port = (server.address() as { port: number }).port;
        const curl = windowsSystemExecutable("curl.exe").replaceAll("\\", "/");
        const args = `--noproxy '*' --cacert '${certPath.replaceAll("\\", "/")}' --connect-to '${bucket}:443:127.0.0.1:${port}' --connect-to '${regional}:443:127.0.0.1:${port}'`;
        for (const reject of [true, false]) {
          rejectBucket = reject;
          requests.length = 0;
          let command = buildUploadNetworkProbeCommand(
            `https://${bucket}/PRIVATE?X-Amz-Signature=SECRET`,
            shellKind,
          )!;
          if (shellKind === "cmd") {
            const script = Buffer.from(command.split(" ").at(-1)!, "base64")
              .toString("utf16le")
              .replaceAll("curl.exe", `& '${curl}' ${args}`);
            command = `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
          } else
            command = `curl() { ${quote(curl)} ${args} "$@"; }\n${command}`;
          const shell =
            shellKind === "cmd" ? windowsSystemExecutable("cmd.exe") : bash;
          const spec = buildShellSpawn(
            shell,
            shellKind === "cmd" ? "/c" : "-c",
            command,
          );
          const result = await run(shell, spec.args, {
            ...spec.options,
            timeout: 12_000,
            env: {
              ...process.env,
              MSYS_NO_PATHCONV: "1",
              MSYS2_ARG_CONV_EXCL: "*",
            },
          });
          const parsed = parseUploadNetworkProbe(result.stdout);
          expect(parsed).toMatchObject({
            probe_status: "complete",
            tls_backend: "schannel",
            probes: [
              {
                endpoint_form: "virtual_hosted",
                curl_exit_code: reject ? 35 : 0,
                http_status: reject ? null : 403,
              },
              {
                endpoint_form: "regional",
                curl_exit_code: 0,
                http_status: 403,
              },
            ],
          });
          expect(requests).toEqual(
            Array.from({ length: reject ? 1 : 2 }, () => ({
              method: "HEAD",
              url: "/",
              bytes: 0,
              authorization: undefined,
            })),
          );
        }
      } finally {
        if (server) await new Promise<void>((r) => server!.close(() => r()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
