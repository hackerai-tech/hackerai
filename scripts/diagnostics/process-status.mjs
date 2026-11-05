#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const names = new Set([
  "node",
  "nodejs",
  "python",
  "python3",
  "convex-backend",
  "ps",
  "cargo",
  "rustc",
  "HackerAI",
  "hackerai",
  "codex",
  "claude",
  "Google Chrome",
  "Google Chrome Helper",
]);
function validatePids(pids) {
  if (
    !Array.isArray(pids) ||
    pids.length < 1 ||
    pids.length > 16 ||
    pids.some(
      (pid) => !Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647,
    )
  ) {
    throw new Error("Invalid process selection");
  }
  return [...new Set(pids)].sort((a, b) => a - b);
}
function elapsedSeconds(raw) {
  const m = /^(?:(\d{1,6})-)?(?:(\d{1,3}):)?(\d{1,2}):(\d{2})$/.exec(raw);
  if (!m || +m[3] > 59 || +m[4] > 59) throw new Error("Invalid process data");
  return +(m[1] || 0) * 86400 + +(m[2] || 0) * 3600 + +m[3] * 60 + +m[4];
}
export function parseProcessStatus(stdout, pids) {
  const requested = new Set(validatePids(pids));
  if (typeof stdout !== "string" || Buffer.byteLength(stdout) > 65_536) {
    throw new Error("Invalid process data");
  }
  const processes = [];
  const seen = new Set();
  for (const line of stdout.split("\n").filter((line) => line.trim())) {
    const m =
      /^\s*(\d+)\s+(\d+)\s+([A-Za-z+<>()-]{1,16})\s+([\d:-]{1,32})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.{1,4096})$/.exec(
        line,
      );
    if (!m) throw new Error("Invalid process data");
    const [
      ,
      pidText,
      parentText,
      rawState,
      elapsed,
      cpuText,
      memoryText,
      command,
    ] = m;
    const pid = Number(pidText),
      parentPid = Number(parentText);
    const cpuPercent = Number(cpuText),
      memoryPercent = Number(memoryText);
    if (
      !requested.has(pid) ||
      seen.has(pid) ||
      !Number.isSafeInteger(parentPid) ||
      parentPid < 0 ||
      parentPid > 2_147_483_647 ||
      cpuPercent > 100_000 ||
      memoryPercent > 100
    )
      throw new Error("Invalid process data");
    seen.add(pid);
    const name = basename(command);
    // A process name/path is also untrusted: never echo arbitrary executable names.
    const executable = names.has(name)
      ? name
      : /^python3\.\d{1,2}$/.test(name)
        ? "python3"
        : "other";
    const state =
      {
        R: "running",
        S: "sleeping",
        I: "idle",
        T: "stopped",
        Z: "zombie",
        D: "waiting",
        U: "waiting",
      }[rawState[0]] || "unknown";
    processes.push({
      pid,
      parentPid,
      state,
      elapsedSeconds: elapsedSeconds(elapsed),
      cpuPercent,
      memoryPercent,
      executable,
    });
  }
  return {
    ok: true,
    processes,
    missingPids: [...requested].filter((pid) => !seen.has(pid)),
  };
}
async function runPs(pids) {
  try {
    return await execute(
      "/bin/ps",
      ["-p", pids.join(","), "-o", "pid=,ppid=,stat=,etime=,pcpu=,pmem=,comm="],
      {
        encoding: "utf8",
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
        env: { PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" },
      },
    );
  } catch (error) {
    if (error.code === 1 && !error.stdout?.trim() && !error.stderr?.trim())
      return { stdout: "", stderr: "" };
    throw new Error("Process inspection failed");
  }
}
export async function getProcessStatus(
  pids,
  { run = runPs, platform = process.platform } = {},
) {
  let selected;
  try {
    selected = validatePids(pids);
  } catch {
    return { ok: false, reason: "invalid-pids" };
  }
  if (!["darwin", "linux"].includes(platform))
    return { ok: false, reason: "unsupported-platform" };
  let result;
  try {
    result = await run(selected);
  } catch {
    return { ok: false, reason: "process-inspection-failed" };
  }
  if (!result || typeof result.stderr !== "string" || result.stderr.trim())
    return { ok: false, reason: "invalid-output" };
  try {
    return parseProcessStatus(result.stdout, selected);
  } catch {
    return { ok: false, reason: "invalid-output" };
  }
}
export async function main(args) {
  if (args.some((arg) => !/^[1-9]\d{0,9}$/.test(arg)))
    return { ok: false, reason: "invalid-pids" };
  return getProcessStatus(args.map(Number));
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
    .then((result) => {
      console.log(JSON.stringify(result));
      if (!result.ok) process.exitCode = 1;
    })
    .catch(() => {
      console.log(
        JSON.stringify({ ok: false, reason: "process-inspection-failed" }),
      );
      process.exitCode = 1;
    });
}
