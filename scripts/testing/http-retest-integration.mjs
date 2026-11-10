#!/usr/bin/env node
// Linux integration check for the fixed executable-retest runner.
// Runs the exact shipped Python program (`python3 -I -S -c ...`) with its plan
// on stdin and in the cloud env-variable mode against a disposable loopback
// fixture. Requires Node with TypeScript type stripping (>= 22.18) and python3.
//
//   node scripts/testing/http-retest-integration.mjs
//
// Exits non-zero on the first failed expectation. Synthetic data only.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const {
  HTTP_RETEST_PYTHON_PROGRAM,
  HTTP_RETEST_RESULT_MARKER,
  HTTP_RETEST_INPUT_ENV,
} = await import(path.join(root, "lib/findings/http-retest-python.ts"));

const TOKEN = `synthetic-${process.pid}-token`;

const fixture = spawn(
  "python3",
  [path.join(root, "scripts/testing/http-retest-fixture.py")],
  {
    stdio: ["ignore", "pipe", "inherit"],
    env: { PATH: process.env.PATH, HACKERAI_RETEST_FIXTURE_TOKEN: TOKEN },
  },
);
const cleanup = () => fixture.kill("SIGTERM");
process.on("exit", cleanup);
const ready = createInterface({ input: fixture.stdout });
const [address] = await once(ready, "line", {
  signal: AbortSignal.timeout(5_000),
});
ready.close();
const port = Number(address);
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("The loopback fixture did not report its listening port.");

const plan = (probe, token = TOKEN) => ({
  scheme: "http",
  host: "127.0.0.1",
  port,
  timeout_s: 2,
  deadline_s: 30,
  max_bytes: 1_048_576,
  steps: [
    {
      kind: "baseline",
      index: 0,
      path: "/own",
      headers: [["Authorization", `Bearer ${token}`]],
      status: 200,
      json: [{ path: ["owner_id"], equals: "usr_tester_b" }],
      contains: [],
      nonrepro: null,
    },
    {
      kind: "probe",
      index: 0,
      path: `/victim/${probe}`,
      headers: [["Authorization", `Bearer ${token}`]],
      status: 200,
      json: [{ path: ["owner_id"], equals: "usr_victim_a" }],
      contains: [],
      nonrepro: [403, 404],
    },
  ],
});

const runPython = (input, viaEnv) =>
  new Promise((resolve) => {
    const env = { PATH: process.env.PATH };
    if (viaEnv)
      env[HTTP_RETEST_INPUT_ENV] = Buffer.from(input).toString("base64");
    const child = spawn(
      "python3",
      ["-I", "-S", "-c", HTTP_RETEST_PYTHON_PROGRAM],
      { env },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => resolve({ code, stdout }));
    child.stdin.end(viaEnv ? "" : input);
  });

let failures = 0;
const check = (name, condition) => {
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
  if (!condition) failures++;
};

for (const viaEnv of [false, true]) {
  const transport = viaEnv ? "env" : "stdin";
  const cases = [
    ["vulnerable", TOKEN, (s) => s[1]?.matched === true],
    [
      "fixed",
      TOKEN,
      (s) => s[1]?.status === 403 && s[1].nonreproduction_matched === true,
    ],
    ["redirect", TOKEN, (s) => s[1]?.error === "redirect"],
    ["oversized", TOKEN, (s) => s[1]?.error === "oversized"],
    [
      "unexpected",
      TOKEN,
      (s) =>
        s[1]?.status === 500 && !s[1].matched && !s[1].nonreproduction_matched,
    ],
    [
      "vulnerable",
      "expired-token",
      (s) => s.length === 1 && s[0].status === 401,
    ],
  ];
  for (const [probe, token, expectation] of cases) {
    const { code, stdout } = await runPython(
      JSON.stringify(plan(probe, token)),
      viaEnv,
    );
    const line = stdout
      .split("\n")
      .find((l) => l.startsWith(HTTP_RETEST_RESULT_MARKER));
    const result = line
      ? JSON.parse(line.slice(HTTP_RETEST_RESULT_MARKER.length))
      : null;
    check(
      `${transport} ${probe}${token === TOKEN ? "" : " (expired)"} exit 0`,
      code === 0,
    );
    check(
      `${transport} ${probe} expectation`,
      !!result && expectation(result.steps ?? []),
    );
    check(
      `${transport} ${probe} output has no token or body`,
      !stdout.includes(TOKEN) &&
        !stdout.includes("VICTIM-BODY") &&
        !stdout.includes("TESTER-BODY"),
    );
  }
}

cleanup();
console.log(failures === 0 ? "ALL PASSED" : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
