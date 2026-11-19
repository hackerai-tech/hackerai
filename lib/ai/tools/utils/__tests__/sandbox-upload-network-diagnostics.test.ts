import { execFile } from "node:child_process";
import { mkdtemp, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  buildUploadNetworkProbeCommand,
  parseUploadNetworkProbe,
} from "../sandbox-upload-network-diagnostics";

const url =
  "https://qa-bucket.s3.us-east-1.amazonaws.com/PRIVATE?X-Amz-Signature=SECRET";
const marker = "__HACKERAI_UPLOAD_NET_V1__";
const sample = (form: string, fields = "403:0.010000:0.020000:0.030000:0") =>
  `${marker}:${form}:${fields.split(":").slice(0, -1).join(":")}\n__HACKERAI_UPLOAD_NET_EXIT_V1__:${form}:${fields.split(":").at(-1)}`;

describe("upload connectivity diagnostics", () => {
  it.each([
    "http://qa-bucket.s3.us-east-1.amazonaws.com/key",
    "https://user:password@qa-bucket.s3.us-east-1.amazonaws.com/key",
    "https://qa-bucket.s3.us-east-1.amazonaws.com:8443/key",
    "https://qa-bucket.s3.us-east-1.amazonaws.com.attacker.invalid/key",
    "https://qa-bucket.s3.invalid.amazonaws.com/key",
    "https://127.0.0.1/key",
    "invalid",
  ])("never probes an unsupported destination: %s", (input) => {
    expect(buildUploadNetworkProbeCommand(input, "posix")).toBeUndefined();
  });

  it.each(["posix", "windows-bash", "cmd"] as const)(
    "strips object and signing data from the %s command",
    (shell) => {
      const encoded = buildUploadNetworkProbeCommand(url, shell, true)!;
      const command =
        shell === "cmd"
          ? Buffer.from(encoded.split(" ").at(-1)!, "base64").toString(
              "utf16le",
            )
          : encoded;
      expect(command).not.toMatch(
        /PRIVATE|SECRET|Signature|--insecure|--location|--upload|--data/,
      );
      expect(command.match(/--head /g)).toHaveLength(2);
      expect(command).toContain(
        "https://qa-bucket.s3.us-east-1.amazonaws.com/",
      );
      expect(command).toContain("https://s3.us-east-1.amazonaws.com/");
    },
  );

  it("keeps only version, backend and bounded numeric measurements", () => {
    const parsed = parseUploadNetworkProbe(
      [
        "curl 8.17.0 (Windows) libcurl/8.17.0 Schannel PRIVATE",
        "PRIVATE stderr, signed URL and body",
        sample("virtual_hosted", "000:0.010000:0.000000:0.100000:35"),
        sample("regional"),
      ].join("\r\n"),
    );
    expect(parsed).toEqual({
      probe_status: "complete",
      curl_version: "8.17.0",
      tls_backend: "schannel",
      probes: [
        {
          endpoint_form: "virtual_hosted",
          curl_exit_code: 35,
          http_status: null,
          tcp_connect_ms: 10,
          tls_connect_ms: 0,
          total_ms: 100,
        },
        {
          endpoint_form: "regional",
          curl_exit_code: 0,
          http_status: 403,
          tcp_connect_ms: 10,
          tls_connect_ms: 20,
          total_ms: 30,
        },
      ],
    });
    expect(JSON.stringify(parsed)).not.toContain("PRIVATE");
  });

  it.each([
    "600:0:0:0:0",
    "403:0:0:0:256",
    "403:0:0:61:0",
    "403:0:0:-1:0",
    "403:0:0:0.1234567:0",
    "403:NaN:0:0:0",
    "403:0:0:0:",
    "403:0:0:0:0 PRIVATE",
  ])("rejects malformed or unsafe samples: %s", (fields) => {
    expect(
      parseUploadNetworkProbe(sample("virtual_hosted", fields)),
    ).toMatchObject({
      probe_status: "invalid_response",
      probes: [],
    });
  });

  it("rejects duplicate samples and oversized output without discarding a valid peer", () => {
    const output = [
      sample("virtual_hosted"),
      sample("virtual_hosted"),
      sample("regional"),
    ].join("\n");
    expect(parseUploadNetworkProbe(output)).toMatchObject({
      probe_status: "partial",
      probes: [{ endpoint_form: "regional" }],
    });
    expect(parseUploadNetworkProbe(output + "x".repeat(8192))).toMatchObject({
      probe_status: "invalid_response",
      curl_version: null,
      probes: [],
    });
    expect(parseUploadNetworkProbe(undefined)).toMatchObject({
      probe_status: "unavailable",
      probes: [],
    });
  });

  (process.platform === "win32" ? it.skip : it)(
    "runs both HEADs despite inherited errexit and never sends signed paths or bodies",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "upload-probe-"));
      try {
        // Fake only the external executable: exercise the generated shell and real
        // curl write-out expansion. First HEAD deliberately fails before connect.
        const script = `#!/bin/bash
if [ "$1" = --version ]; then exec /usr/bin/curl --version; fi
case "$*" in *PRIVATE*|*SECRET*|*--data*) exit 99;; esac
host="https://s3.us-east-1.amazonaws.com/"
for value in "$@"; do case "$value" in https://*) host="$value";; esac; done
format=""
while [ "$#" -gt 0 ]; do if [ "$1" = --write-out ]; then shift; format="$1"; fi; shift; done
case "$host" in *qa-bucket*) exec /usr/bin/curl -s --head --max-time 1 --write-out "$format" http://127.0.0.1:1/;; esac
exec /usr/bin/curl -s --head --max-time 1 --write-out "$format" http://127.0.0.1:1/
`;
        await writeFile(join(dir, "curl"), script);
        await chmod(join(dir, "curl"), 0o700);
        const result = await promisify(execFile)(
          "/bin/bash",
          ["-ec", buildUploadNetworkProbeCommand(url, "posix")!],
          { env: { ...process.env, PATH: dir + ":" + process.env.PATH } },
        );
        expect(parseUploadNetworkProbe(result.stdout)).toMatchObject({
          probe_status: "complete",
          probes: [{ curl_exit_code: 7 }, { curl_exit_code: 7 }],
        });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
