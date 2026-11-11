import { closeSync, openSync, readSync } from "node:fs";

const ROOT = "/sys/fs/cgroup";
const MAX_READ_BYTES = 8192;

export type AgentCgroupMemoryFields = {
  cgroup_memory_version?: 1;
  cgroup_memory_status?: "available" | "unavailable" | "self_unverified";
  cgroup_memory_scope?: "self_membership";
  cgroup_memory_current_bytes?: number;
  cgroup_memory_peak_bytes?: number;
  cgroup_memory_limit_kind?: "bounded" | "unlimited";
  cgroup_memory_limit_bytes?: number;
  cgroup_lifetime_high_events?: number;
  cgroup_lifetime_max_events?: number;
  cgroup_lifetime_oom_events?: number;
  cgroup_lifetime_oom_kill_events?: number;
};

/** Read a small kernel file without retaining paths, errors or a truncated value. */
function readKernelFile(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(file, "r");
    const bytes = Buffer.alloc(MAX_READ_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const size = readSync(fd, bytes, length, bytes.length - length, length);
      if (size === 0) break;
      length += size;
    }
    return length <= MAX_READ_BYTES
      ? bytes.toString("utf8", 0, length)
      : undefined;
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Optional diagnostics cannot affect task execution.
      }
    }
  }
}

/** Retain exact bounded kernel integers; unknown readings are not zero. */
function counter(value: string | undefined): number | undefined {
  if (!value || !/^\d+$/.test(value.trim())) return;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}

/**
 * Sample only a cgroup containing this PID, not an assumed container or host root.
 * Values include the group's descendants; peaks/counters can predate this run.
 * This is a capture-time kernel view, not a physical kill or restore receipt.
 * Group identity is not measured: do not attribute counter deltas across samples.
 */
export function readAgentCgroupMemory(
  source: (file: string) => string | undefined = readKernelFile,
): AgentCgroupMemoryFields {
  if (process.platform !== "linux") return {};
  const missing: AgentCgroupMemoryFields = {
    cgroup_memory_version: 1,
    cgroup_memory_status: "unavailable",
  };
  try {
    const read = (file: string) => {
      const value = source(file);
      return value !== undefined &&
        Buffer.byteLength(value, "utf8") <= MAX_READ_BYTES
        ? value
        : undefined;
    };
    const membership =
      read("/proc/self/cgroup")?.match(/^0::(\/[^\n]*)$/m)?.[1];
    if (
      !membership ||
      membership.length > 512 ||
      membership
        .split("/")
        .some((part) =>
          part
            ? !/^(?:[A-Za-z0-9_.:@-]|\\x[0-9a-fA-F]{2})+$/.test(part) ||
              part === "." ||
              part === ".."
            : false,
        )
    )
      return missing;

    // A cgroup namespace can mount our group at ROOT. Without a namespace,
    // membership is relative to ROOT. Confirm membership in either case.
    const candidates = membership === "/" ? [ROOT] : [ROOT, ROOT + membership];
    const group = candidates.find((candidate) =>
      read(candidate + "/cgroup.procs")
        ?.split(/\s+/)
        .includes(String(process.pid)),
    );
    if (!group) return { ...missing, cgroup_memory_status: "self_unverified" };

    const current = counter(read(group + "/memory.current"));
    const limit = read(group + "/memory.max")?.trim();
    const limitBytes = counter(limit);
    if (current === undefined || (limit !== "max" && limitBytes === undefined))
      return missing;

    const fields: AgentCgroupMemoryFields = {
      cgroup_memory_version: 1,
      cgroup_memory_status: "available",
      cgroup_memory_scope: "self_membership",
      cgroup_memory_current_bytes: current,
      cgroup_memory_limit_kind: limit === "max" ? "unlimited" : "bounded",
      ...(limitBytes === undefined
        ? {}
        : { cgroup_memory_limit_bytes: limitBytes }),
    };
    const peak = counter(read(group + "/memory.peak"));
    if (peak !== undefined) fields.cgroup_memory_peak_bytes = peak;
    const events = read(group + "/memory.events");
    for (const [key, field] of [
      ["high", "cgroup_lifetime_high_events"],
      ["max", "cgroup_lifetime_max_events"],
      ["oom", "cgroup_lifetime_oom_events"],
      ["oom_kill", "cgroup_lifetime_oom_kill_events"],
    ] as const) {
      const value = counter(
        events?.match(new RegExp(`^${key} (\\d+)$`, "m"))?.[1],
      );
      if (value !== undefined) fields[field] = value;
    }
    return fields;
  } catch {
    return missing;
  }
}
