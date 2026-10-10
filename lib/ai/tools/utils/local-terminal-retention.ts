import { recordTerminalMaintenance } from "@/lib/centrifugo/terminal-maintenance-metrics";
import type { AnySandbox } from "@/types";
import { isCentrifugoSandbox } from "./sandbox-types";

// Execute the scan beside the records: downloading their saved output to decide
// retention can transfer megabytes on every terminal start. The schema is sent
// by the caller so this small validator stays aligned with recovery validation.
const RETENTION_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const input = JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8"));
function supported(schema) {
  // Fail closed if recovery adds a constraint this deliberately small validator
  // cannot enforce. additionalProperties is ignored because Zod strips extras.
  const keys = ["$schema", "type", "anyOf", "const", "enum", "minimum", "maximum",
    "maxLength", "pattern", "maxItems", "items", "required", "properties", "additionalProperties"];
  return Object.keys(schema).every(key => keys.includes(key)) &&
    (!schema.anyOf || schema.anyOf.every(supported)) &&
    (!schema.items || supported(schema.items)) &&
    (!schema.properties || Object.values(schema.properties).every(supported));
}
function valid(value, schema) {
  if (schema.anyOf) return schema.anyOf.some(s => valid(value, s));
  if (Array.isArray(schema.type)) return schema.type.some(type => valid(value, { ...schema, type }));
  if ("const" in schema && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  switch (schema.type) {
    case "null": return value === null;
    case "boolean": return typeof value === "boolean";
    case "number":
    case "integer":
      return typeof value === "number" && Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum);
    case "string":
      return typeof value === "string" &&
        (schema.maxLength === undefined || value.length <= schema.maxLength) &&
        (!schema.pattern || new RegExp(schema.pattern).test(value));
    case "array":
      return Array.isArray(value) &&
        (schema.maxItems === undefined || value.length <= schema.maxItems) &&
        value.every(item => valid(item, schema.items));
    case "object":
      return value !== null && typeof value === "object" && !Array.isArray(value) &&
        (schema.required || []).every(key => Object.hasOwn(value, key)) &&
        Object.entries(schema.properties).every(([key, s]) =>
          !Object.hasOwn(value, key) || valid(value[key], s));
    default: return false;
  }
}
// Like z.object().parse(), unknown object keys do not invalidate a record.
function owned(stat) { return Number(stat.uid) === process.getuid(); }
function privateDirectory(name) {
  const stat = fs.lstatSync(name);
  return stat.isDirectory() && owned(stat) && (stat.mode & 0o022) === 0;
}
function unchanged(a, b) {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function prune() {
  if (!supported(input.schema) || path.dirname(input.directory) !== input.root ||
      !/^[a-f0-9]{64}$/.test(path.basename(input.directory)) ||
      !privateDirectory(input.root) || !privateDirectory(input.directory)) {
    return { complete: false };
  }
  const entries = fs.readdirSync(input.directory);
  if (entries.length > 4096) return { complete: false };
  const records = [];
  for (const name of entries) {
    if (!/^[a-f0-9]{8}\.json$/.test(name)) continue;
    const file = path.join(input.directory, name);
    let fd;
    try {
      const before = fs.lstatSync(file, { bigint: true });
      if (!before.isFile() || !owned(before) || before.size > 2000000n) continue;
      fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const opened = fs.fstatSync(fd, { bigint: true });
      if (!opened.isFile() || !unchanged(before, opened)) continue;
      const buffer = Buffer.alloc(Number(opened.size) + 1);
      let length = 0;
      while (length < buffer.length) {
        const n = fs.readSync(fd, buffer, length, buffer.length - length, null);
        if (!n) break;
        length += n;
      }
      const after = fs.fstatSync(fd, { bigint: true });
      if (!unchanged(opened, after) || length !== Number(opened.size)) continue;
      const record = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      if (!valid(record, input.schema) || record.session !== name.slice(0, -5) ||
          record.sandboxInstance !== input.sandboxInstance) continue;
      records.push({ file, updatedAt: record.updatedAt, stat: after });
    } catch {
      // A torn write, permission error or unknown record is not proof of expiry.
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }
  records.sort((a, b) => b.updatedAt - a.updatedAt);
  let removed = 0;
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (i < input.maxRecords && record.updatedAt >= input.cutoff) continue;
    try {
      // A checkpoint can replace/rewrite a record while the scan is in progress.
      // Recheck both the scope and file identity immediately before deletion.
      if (!privateDirectory(input.root) || !privateDirectory(input.directory)) break;
      if (!unchanged(record.stat, fs.lstatSync(record.file, { bigint: true }))) continue;
      fs.unlinkSync(record.file);
      removed++;
    } catch { /* Disconnects and concurrent checkpoints preserve the artifact. */ }
  }
  return { complete: true, scanned: records.length, removed };
}
try { process.stdout.write(JSON.stringify(prune())); }
catch { process.stdout.write(JSON.stringify({ complete: false })); }
`;

/** Returns false only when this host needs the existing file-API fallback. */
export async function pruneLocalTerminalRecords(
  sandbox: AnySandbox,
  input: {
    root: string;
    directory: string;
    sandboxInstance: string;
    schema: object;
    cutoff: number;
    maxRecords: number;
  },
): Promise<boolean> {
  // Windows file APIs and command shells can resolve /tmp on different drives.
  // Keep their established file path semantics until that mapping is explicit.
  if (!isCentrifugoSandbox(sandbox)) return false;
  if (sandbox.isWindows()) {
    recordTerminalMaintenance(sandbox, {
      operation: "prune_route",
      outcome: "fallback",
      reason: "windows",
      transport: "native_file",
    });
    return false;
  }
  let outcome: "success" | "failure" | "fallback" | "incomplete" = "failure";
  try {
    const script = Buffer.from(RETENTION_SCRIPT).toString("base64");
    const payload = Buffer.from(JSON.stringify(input)).toString("base64");
    const result = await sandbox.commands.run(
      `if command -v node >/dev/null 2>&1; then node -e "if (Number(process.versions.node.split('.')[0]) < 18) process.stdout.write(JSON.stringify({unavailable:true})); else eval(Buffer.from('${script}','base64').toString())" '${payload}'; else printf '%s' '{"unavailable":true}'; fi`,
      { displayName: "", timeoutMs: 30_000 },
    );
    if (result.exitCode !== 0 || result.stdout.length > 1024)
      throw new Error("Terminal retention scan unavailable");
    const summary: unknown = JSON.parse(result.stdout);
    if (
      summary &&
      typeof summary === "object" &&
      "unavailable" in summary &&
      summary.unavailable === true
    ) {
      outcome = "fallback";
      return false;
    }
    if (
      !summary ||
      typeof summary !== "object" ||
      !("complete" in summary) ||
      typeof summary.complete !== "boolean"
    )
      throw new Error("Invalid terminal retention scan result");
    outcome = summary.complete ? "success" : "incomplete";
    return true;
  } finally {
    recordTerminalMaintenance(sandbox, {
      operation: "prune_route",
      outcome,
      transport: "posix_command",
      ...(outcome === "fallback"
        ? { reason: "node_unavailable" as const }
        : {}),
    });
  }
}
