/** @jest-environment node */
jest.mock("server-only", () => ({}), { virtual: true });

import { spawn } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AnySandbox } from "@/types";
import { reserveCloudUploadFallbackPath } from "../cloud-upload-path-recovery";
import { uploadSandboxFiles } from "../sandbox-file-utils";

// The reservation and transfer commands run in a real shell against a
// task-owned directory tree. Windows has no /bin/bash; cloud workspaces are
// Linux, so the POSIX run is the relevant one.
const posixIt = process.platform === "win32" ? it.skip : it;

const FIXTURE = Buffer.from([0, 1, 2, 250, 251, 252, 10, 13, 0, 255]);
// Transfer stand-in: stores the fixture at curl's -o destination with real
// filesystem semantics. Destinations outside the lab fail like an unwritable
// path, so the test never writes to the host's own upload locations.
const CURL_SHIM = `#!/bin/sh
out=
while [ $# -gt 0 ]; do
  [ "$1" = "-o" ] && { out=$2; shift; }
  shift
done
case "$out" in
  "$LAB_ROOT"/*) cp "$LAB_FIXTURE" "$out" 2>/dev/null && exit 0 ;;
esac
echo "curl: (23) Failure writing output to destination" >&2
exit 23
`;

// Every base the reservation may try is a directory inside the lab.
const BASES = ["tmp", "vartmp", "home", "work"] as const;
type Lab = { root: string; tmpLink: string } & Record<
  (typeof BASES)[number],
  string
>;
let lab: Lab;
const staleRoot = (base: (typeof BASES)[number]) =>
  path.join(lab[base], "hackerai-upload");

beforeEach(() => {
  for (const level of ["info", "warn", "error"] as const)
    jest.spyOn(console, level).mockImplementation(() => {});
  const root = realpathSync(
    mkdtempSync(path.join(tmpdir(), "hackerai-cloud-upload-")),
  );
  lab = {
    root,
    tmp: path.join(root, "tmp"),
    vartmp: path.join(root, "vartmp"),
    home: path.join(root, "home"),
    work: path.join(root, "work"),
    tmpLink: path.join(root, "tmp-link"),
  };
  mkdirSync(path.join(root, "bin"));
  for (const base of BASES) {
    mkdirSync(lab[base]);
    // A shared staging root left behind by another user: present but
    // unwritable, in every base at once.
    mkdirSync(staleRoot(base));
    chmodSync(staleRoot(base), 0o555);
  }
  symlinkSync(lab.tmp, lab.tmpLink);
  writeFileSync(path.join(root, "fixture"), FIXTURE);
  writeFileSync(path.join(root, "bin", "curl"), CURL_SHIM, { mode: 0o755 });
});
afterEach(() => {
  jest.restoreAllMocks();
  rmSync(lab.root, { recursive: true, force: true });
});

/** E2B-shaped command surface whose commands execute in the lab. */
function labSandbox(tmpdirPath = lab.tmpLink) {
  const start = (command: string) => {
    // The script's one fixed base is outside the lab; point that literal at
    // the lab's own directory and leave the rest of the shell logic as is.
    const confined = command.split(" /var/tmp ").join(` "${lab.vartmp}" `);
    // A permissive umask: owner-only access must come from the reservation.
    const child = spawn("/bin/bash", ["-c", `umask 022\n${confined}`], {
      cwd: lab.work,
      env: {
        PATH: `${path.join(lab.root, "bin")}:${process.env.PATH}`,
        TMPDIR: tmpdirPath,
        HOME: lab.home,
        LAB_ROOT: lab.root,
        LAB_FIXTURE: path.join(lab.root, "fixture"),
      },
    });
    const state = {
      pid: child.pid ?? 0,
      exitCode: undefined as number | undefined,
      stdout: "",
      stderr: "",
    };
    child.stdout.on("data", (chunk) => (state.stdout += chunk));
    child.stderr.on("data", (chunk) => (state.stderr += chunk));
    const done = new Promise<typeof state>((resolve, reject) => {
      child.on("error", reject);
      child.on("close", (code) => {
        state.exitCode = code ?? -1;
        if (state.exitCode === 0) resolve(state);
        // The SDK rejects a nonzero exit instead of returning it.
        else
          reject(
            Object.assign(new Error(`exit status ${state.exitCode}`), {
              name: "CommandExitError",
              exitCode: state.exitCode,
              stdout: state.stdout,
              stderr: state.stderr,
            }),
          );
      });
    });
    return { state, done };
  };
  return {
    sandboxId: "lab-sandbox",
    commands: {
      run: async (command: string, options?: { background?: boolean }) => {
        // The write probe inspects the intended destination on the host.
        // Report its tools missing, which the upload already tolerates.
        if (command.startsWith("timeout "))
          throw Object.assign(new Error("exit status 127"), {
            name: "CommandExitError",
            exitCode: 127,
          });
        const { state, done } = start(command);
        if (!options?.background) return done;
        return Object.assign(state, {
          wait: () => done,
          disconnect: async () => {},
        });
      },
      kill: async () => false,
    },
  } as unknown as AnySandbox;
}

const expectStaleRootsUntouched = () => {
  for (const base of BASES) {
    expect(statSync(staleRoot(base)).mode & 0o777).toBe(0o555);
    expect(readdirSync(staleRoot(base))).toEqual([]);
  }
};

posixIt.each([false, true])(
  "reserves an owner-only directory beside an unwritable shared root (free-space check: %s)",
  async (requireFreeSpace) => {
    const fileName = "it's a report.txt";
    const reserved = await reserveCloudUploadFallbackPath(
      labSandbox(),
      `/home/user/upload/namespace/${fileName}`,
      undefined,
      requireFreeSpace,
    );

    // The symlinked base resolves to its canonical location.
    expect(reserved).not.toBeNull();
    const directory = path.dirname(reserved!);
    expect(path.dirname(directory)).toBe(lab.tmp);
    expect(path.basename(directory)).toMatch(/^hackerai-upload-[0-9a-f-]{36}$/);
    expect(path.basename(reserved!)).toBe(fileName);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    expect(readdirSync(directory)).toEqual([]);
    expectStaleRootsUntouched();
  },
  20_000,
);

posixIt(
  "moves to the next base when one cannot be entered",
  async () => {
    const reserved = await reserveCloudUploadFallbackPath(
      labSandbox(path.join(lab.root, "absent")),
      "/home/user/upload/namespace/report.txt",
    );

    expect(reserved).not.toBeNull();
    expect(path.dirname(path.dirname(reserved!))).toBe(lab.vartmp);
    expectStaleRootsUntouched();
  },
  20_000,
);

posixIt(
  "stages the attachment bytes through the application upload when every shared root is stale",
  async () => {
    const primary = `/home/user/upload/${"a".repeat(64)}/report.txt`;
    const result = await uploadSandboxFiles(
      [
        {
          kind: "url",
          url: "https://example.com/report.txt",
          localPath: primary,
        },
      ],
      async () => labSandbox(),
      { signal: new AbortController().signal },
    );

    expect(result.failedCount).toBe(0);
    expect(result.pathRewrites).toHaveLength(1);
    const [{ from, to }] = result.pathRewrites;
    expect(from).toBe(primary);
    expect(path.dirname(path.dirname(to))).toBe(lab.tmp);
    expect(path.basename(to)).toBe("report.txt");
    expect(readFileSync(to).equals(FIXTURE)).toBe(true);
    expectStaleRootsUntouched();
  },
  20_000,
);

it("rejects output that does not name the directory this call reserved", async () => {
  const run = jest.fn(async () => ({
    exitCode: 0,
    stdout: "/tmp/hackerai-upload/elsewhere/report.txt\n",
    stderr: "",
  }));
  await expect(
    reserveCloudUploadFallbackPath(
      { commands: { run } } as unknown as AnySandbox,
      "/home/user/upload/namespace/report.txt",
    ),
  ).resolves.toBeNull();
  expect(run).toHaveBeenCalledTimes(1);
});
