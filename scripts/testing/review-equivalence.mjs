import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sha = (value) => /^[a-f0-9]{40}$/.test(value ?? "");
const git = (cwd, args, extraEnv = {}) =>
  execFileSync(
    "git",
    ["--no-replace-objects", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd,
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([key]) => !key.startsWith("GIT_"),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_COUNT: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        ...extraEnv,
      },
    },
  ).trim();

/** Use only in an isolated bare repository with no configured external merge drivers. */
export function verifyReviewMerge(reviewed, base, head, { cwd } = {}) {
  if (!cwd || ![reviewed, base, head].every(sha)) return false;
  try {
    git(cwd, ["merge-base", "--is-ancestor", reviewed, head]);
    git(cwd, ["merge-base", "--is-ancestor", base, head]);
    const expected = git(cwd, ["merge-tree", "--write-tree", reviewed, base]);
    return (
      sha(expected) && expected === git(cwd, ["rev-parse", `${head}^{tree}`])
    );
  } catch {
    return false;
  }
}

/** Fetch pinned objects into an isolated bare repo; never check out or execute PR code. */
export function reviewMergeVerifier(repo, token) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("Invalid repository");
  return (reviewed, base, head) => {
    if (![reviewed, base, head].every(sha)) return false;
    const cwd = mkdtempSync(join(tmpdir(), "review-merge-"));
    try {
      git(cwd, ["init", "--bare", "--template="]);
      // Authentication exists only in this child process environment, never argv or disk.
      git(
        cwd,
        [
          "fetch",
          "--no-tags",
          "--no-recurse-submodules",
          `https://github.com/${repo}.git`,
          head,
          base,
        ],
        token
          ? {
              GIT_CONFIG_COUNT: "1",
              GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
              GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
            }
          : {},
      );
      return verifyReviewMerge(reviewed, base, head, { cwd });
    } catch {
      return false;
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  };
}
