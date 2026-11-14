import { execFile } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import {
  createServer as createTcpServer,
  type AddressInfo,
  type Server,
  type Socket,
} from "node:net";
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
  getAttachmentDownloadFailureContext,
  recordAttachmentDownloadFailure,
} from "../attachment-download-diagnostics";

const run = promisify(execFile);
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const host = "attachments.hackerai.test";
const unlistedHost = "unlisted.hackerai.test";
const body = "owned attachment bytes\n";
// A complete fatal handshake_failure alert record, before any ServerHello.
const fatalAlert = Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x28]);
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const listen = (server: Server) =>
  new Promise<number>((r) =>
    server.listen(0, "127.0.0.1", () =>
      r((server.address() as AddressInfo).port),
    ),
  );
const curl35Keys = [
  "attachment_download_curl35_version",
  "attachment_download_curl35_line_present",
  "attachment_download_curl35_hint",
];

windowsDescribe("native Windows curl35 TLS reason diagnostics", () => {
  it.each(["cmd", "bash"] as const)(
    "records only closed public reasons from live system curl through %s",
    async (shellKind) => {
      const bash = findGitBash();
      if (!bash) throw Error("Git Bash required for Windows acceptance");
      const directory = await mkdtemp(join(tmpdir(), "attachment-curl35-"));
      const sockets = new Set<Socket>();
      let rejection: "alert" | "close" = "alert";
      let rejected = 0;
      // Reject after the ClientHello, before any server handshake message.
      const rejecting = createTcpServer((socket) => {
        sockets.add(socket);
        socket.on("error", () => undefined);
        socket.once("data", () => {
          rejected++;
          if (rejection === "alert") socket.end(fatalAlert);
          else socket.end();
        });
      });
      let tls: ReturnType<typeof createHttpsServer> | undefined;
      try {
        const certPath = join(directory, "cert.pem");
        const keyPath = join(directory, "key.pem");
        // Process-local trust anchor; system trust stores are never changed.
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
          `/CN=${host}`,
          "-addext",
          `subjectAltName=DNS:${host}`,
        ]);
        tls = createHttpsServer(
          { cert: await readFile(certPath), key: await readFile(keyPath) },
          (_req, res) => res.end(body),
        );
        const tlsPort = await listen(tls);
        const rejectPort = await listen(rejecting);
        const output = join(directory, "attachment.bin");
        const curl = windowsSystemExecutable("curl.exe");
        const shell =
          shellKind === "cmd" ? windowsSystemExecutable("cmd.exe") : bash;

        const download = async (target: string, port: number) => {
          const url = `https://${target}/private.bin?X-Amz-Signature=SECRET`;
          // Production download flags without capability-dependent retries.
          const argv = [
            curl,
            "-fsSL",
            "--noproxy",
            `${host},${unlistedHost}`,
            "--connect-timeout",
            "5",
            "--max-time",
            "10",
            "--cacert",
            certPath,
            "--connect-to",
            `${target}:443:127.0.0.1:${port}`,
            "-o",
            output,
            url,
          ];
          const command =
            shellKind === "cmd"
              ? argv.map((arg) => `"${arg}"`).join(" ")
              : argv.map((arg) => quote(arg.replaceAll("\\", "/"))).join(" ");
          const spec = buildShellSpawn(
            shell,
            shellKind === "cmd" ? "/c" : "-c",
            command,
          );
          const result = await run(shell, spec.args, {
            ...spec.options,
            timeout: 15_000,
            env: {
              ...process.env,
              MSYS_NO_PATHCONV: "1",
              MSYS2_ARG_CONV_EXCL: "*",
            },
          }).then(
            ({ stderr }) => ({ code: 0 as unknown, stderr }),
            (error: { code?: unknown; stderr?: string }) => ({
              code: error.code,
              stderr: error.stderr ?? "",
            }),
          );
          return {
            code: result.code,
            fields: getAttachmentDownloadFailureContext(
              recordAttachmentDownloadFailure(new Error("private original"), {
                platform: "windows",
                shell: shellKind,
                httpClient: "curl",
                exitCode: Number(result.code),
                stderr: result.stderr,
              }),
            ),
          };
        };

        // The same fixture and trust anchor complete a valid transfer.
        expect((await download(host, tlsPort)).code).toBe(0);
        expect(await readFile(output, "utf8")).toBe(body);

        for (const [mode, hint] of [
          ["alert", "schannel_illegal_message"],
          ["close", "schannel_handshake_receive_failed"],
        ] as const) {
          rejection = mode;
          rejected = 0;
          const { code, fields } = await download(host, rejectPort);
          expect({ mode, code, rejected }).toEqual({
            mode,
            code: 35,
            rejected: 1,
          });
          expect(fields).toMatchObject({
            attachment_download_exit_code: 35,
            attachment_download_stderr_signal: "tls",
            attachment_download_curl35_version: 1,
            attachment_download_curl35_line_present: true,
            attachment_download_curl35_hint: hint,
          });
          expect(JSON.stringify(fields)).not.toMatch(
            /hackerai\.test|127\.0\.0\.1|SEC_E|0x|schannel:|Initialize|Signature|SECRET|private\.bin/,
          );
        }

        // A certificate name rejection is not curl35 and gets no curl35 fields.
        const mismatch = await download(unlistedHost, tlsPort);
        expect(mismatch.code).toBe(60);
        for (const key of curl35Keys)
          expect(mismatch.fields).not.toHaveProperty(key);
      } finally {
        for (const socket of sockets) socket.destroy();
        tls?.closeAllConnections();
        for (const server of [tls, rejecting])
          if (server) await new Promise<void>((r) => server.close(() => r()));
        await rm(directory, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
