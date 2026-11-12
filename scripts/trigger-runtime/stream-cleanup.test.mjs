import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// @trigger.dev/sdk pipeInternal ends its span on a cleanup chain separate from
// the promise callers await through waitUntilComplete. Unpatched, that chain
// re-rejects with nobody observing it, so an S2 failure the app awaits and
// handles also reaches Node as an unhandled rejection, which fails the Trigger
// attempt. Each module format runs the installed SDK in its own child process
// (one realtime-streams manager per process) with an empty environment.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "stream-cleanup.fixture.mjs",
);

async function runFixture(format) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [FIXTURE, format],
    { env: {}, timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

const label = (r) =>
  [
    r.entry,
    r.failure,
    r.delayed && "delayed await",
    r.spanEndThrows && "span.end throws",
  ]
    .filter(Boolean)
    .join(" ");
const otherEntries = [
  "pipe(key)",
  "pipe(default key)",
  "writer",
  "define.writer",
  "define.append",
];
const expectedCases = [
  "define.pipe success",
  "define.pipe s2_hot_server",
  "define.pipe transport_abort",
  "define.pipe caller_cancel",
  "define.pipe s2_hot_server delayed await",
  "define.pipe transport_abort delayed await",
  "define.pipe success span.end throws",
  "define.pipe s2_hot_server span.end throws",
  "define.pipe construct_TypeError",
  "define.pipe construct_AbortError",
  ...otherEntries.flatMap((entry) => [
    `${entry} success`,
    `${entry} s2_hot_server`,
  ]),
];
const spanNames = {
  "define.pipe": "streams.pipe()",
  "pipe(key)": "streams.pipe()",
  "pipe(default key)": "streams.pipe()",
  writer: "streams.writer()",
  "define.writer": "streams.writer()",
  "define.append": "streams.append()",
};

/** What the caller must observe: its own settlement, unchanged telemetry, nothing else. */
function expected(r) {
  const span = { name: spanNames[r.entry], ends: 1, exceptions: 0 };
  if (r.failure.startsWith("construct_")) {
    // Synchronous failures keep the existing catch: AbortError only ends.
    const recorded = r.failure === "construct_TypeError";
    return {
      outcome: "threw",
      settledBeforeAwait: null,
      originalReason: true,
      unhandled: 0,
      spans: [{ ...span, exceptions: Number(recorded), error: recorded }],
    };
  }
  const rejected = ["s2_hot_server", "transport_abort"].includes(r.failure);
  return {
    outcome: rejected ? "rejected" : "fulfilled",
    // A delayed caller first awaits only after the remote failure settled.
    settledBeforeAwait: r.delayed ? true : null,
    originalReason: rejected,
    unhandled: 0,
    spans: [{ ...span, error: false }],
  };
}

for (const format of ["esm", "cjs"])
  test(
    `installed SDK ${format}: callers keep their own result and nothing else rejects`,
    { timeout: 90_000 },
    async (t) => {
      const report = await runFixture(format);
      assert.equal(report.format, format);
      assert.equal(report.fetchCalls, 0);
      assert.deepEqual(
        report.results.map(label).sort(),
        [...expectedCases].sort(),
      );
      for (const r of report.results)
        await t.test(label(r), () => {
          const { outcome, settledBeforeAwait, originalReason } = r;
          const { unhandled, spans } = r;
          assert.deepEqual(
            { outcome, settledBeforeAwait, originalReason, unhandled, spans },
            expected(r),
          );
        });
    },
  );
