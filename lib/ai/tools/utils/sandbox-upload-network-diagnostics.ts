import { isS3StorageRegion } from "@/lib/constants/s3";

export type UploadProbeShell = "posix" | "windows-bash" | "cmd";
const MARKER = "__HACKERAI_UPLOAD_NET_V1__";
const EXIT_MARKER = "__HACKERAI_UPLOAD_NET_EXIT_V1__";
const quote = (value: string, shell: UploadProbeShell) =>
  shell === "cmd" ? `'${value}'` : `'${value.replaceAll("'", `'"'"'`)}'`;

/** No object keys, signatures, credentials or upload bytes enter these HEADs. */
export function buildUploadNetworkProbeCommand(
  uploadUrl: string,
  shell: UploadProbeShell,
  sslNoRevoke = false,
): string | undefined {
  let url: URL;
  try {
    url = new URL(uploadUrl);
  } catch {
    return;
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password)
    return;
  const match = url.hostname.match(
    /^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])\.s3\.([a-z0-9-]+)\.amazonaws\.com$/,
  );
  if (!match || !isS3StorageRegion(match[2])) return;

  const sink = shell === "posix" ? "/dev/null" : "NUL";
  const redirect = shell === "cmd" ? "2>$null" : "2>/dev/null";
  const curl = shell === "cmd" ? "curl.exe" : "curl";
  const commands = [`${curl} --version ${redirect}`];
  for (const [form, host] of [
    ["virtual_hosted", url.hostname],
    ["regional", `s3.${match[2]}.amazonaws.com`],
  ]) {
    const format = `${MARKER}:${form}:%{http_code}:%{time_connect}:%{time_appconnect}:%{time_total}\\n`;
    const request = `${curl} --head -sS${sslNoRevoke ? " --ssl-no-revoke" : ""} --output ${sink} --connect-timeout 2 --max-time 3 --write-out ${quote(format, shell)} ${quote(`https://${host}/`, shell)} ${redirect}`;
    // Read the process exit status in the shell: %{exitcode} is absent from
    // older Windows curl builds, but their HTTP and timing fields still work.
    commands.push(
      shell === "cmd"
        ? `${request}\nWrite-Output ('${EXIT_MARKER}:${form}:' + $LASTEXITCODE)`
        : `{ ${request}; probe_exit=$?; printf '${EXIT_MARKER}:${form}:%s\\n' "$probe_exit"; }`,
    );
  }
  // Probe failure must not prevent the other hostname from being measured.
  if (shell === "cmd") {
    // cmd expands pairs of percent signs even inside quotes. Keep curl's
    // write-out fields in an encoded PowerShell script; no temp file is needed.
    const script =
      "$ErrorActionPreference = 'Continue'\n" + commands.join("\n");
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
  }
  return `(\n${commands.map((command) => `${command} || :`).join("\n")}\n)`;
}

type Probe = {
  endpoint_form: "virtual_hosted" | "regional";
  curl_exit_code: number;
  http_status: number | null;
  tcp_connect_ms: number;
  tls_connect_ms: number;
  total_ms: number;
};

/** Parse only fixed, bounded numeric fields; discard all other command output. */
export function parseUploadNetworkProbe(output: unknown) {
  const probes: Probe[] = [];
  let curlVersion: string | null = null;
  let tlsBackend:
    | "schannel"
    | "openssl"
    | "libressl"
    | "gnutls"
    | "wolfssl"
    | "securetransport"
    | null = null;
  if (typeof output === "string" && output.length <= 8192) {
    const version = output.match(
      /^curl (\d{1,3}\.\d{1,3}\.\d{1,3})\b[^\r\n]*/m,
    );
    if (version) {
      curlVersion = version[1];
      const backend = version[0].match(
        /\b(Schannel|OpenSSL|LibreSSL|GnuTLS|wolfSSL|SecureTransport)\b/i,
      );
      if (backend)
        tlsBackend = backend[1].toLowerCase() as NonNullable<typeof tlsBackend>;
    }
    for (const form of ["virtual_hosted", "regional"] as const) {
      const lines = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${MARKER}:${form}:`));
      const exits = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith(`${EXIT_MARKER}:${form}:`));
      if (lines.length !== 1 || exits.length !== 1) continue;
      const exit = exits[0].match(
        new RegExp(`^${EXIT_MARKER}:${form}:(\\d{1,3})$`),
      );
      const sample = lines[0].match(
        new RegExp(
          `^${MARKER}:${form}:(\\d{3}):([0-9]+(?:\\.[0-9]{1,6})?):([0-9]+(?:\\.[0-9]{1,6})?):([0-9]+(?:\\.[0-9]{1,6})?)$`,
        ),
      );
      if (!sample || !exit) continue;
      const status = Number(sample[1]);
      const times = sample
        .slice(2, 5)
        .map((value) => Math.round(Number(value) * 1000));
      const exitCode = Number(exit[1]);
      if (
        (status !== 0 && (status < 100 || status > 599)) ||
        exitCode > 255 ||
        times.some((value) => !Number.isSafeInteger(value) || value > 60_000)
      )
        continue;
      probes.push({
        endpoint_form: form,
        curl_exit_code: exitCode,
        http_status: status || null,
        tcp_connect_ms: times[0],
        tls_connect_ms: times[1],
        total_ms: times[2],
      });
    }
  }
  const probeStatus:
    "complete" | "partial" | "invalid_response" | "unavailable" =
    probes.length === 2
      ? "complete"
      : probes.length === 1
        ? "partial"
        : typeof output === "string" && output.length > 0
          ? "invalid_response"
          : "unavailable";
  return {
    probe_status: probeStatus,
    curl_version: curlVersion,
    tls_backend: tlsBackend,
    probes,
  };
}
