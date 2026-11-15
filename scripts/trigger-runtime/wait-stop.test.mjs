import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// A product stop during wait_for_user completes only that invocation's token
// and still awaits the SDK's original wait.forToken promise, so the installed
// runtime clears suspendability, closes its usage pause and releases its
// single-wait guard before the tool throws the first stop reason. Each module
// format runs the installed SDK in its own child process with an empty
// environment against a synthetic first-writer token engine. The engine is not
// the hosted service: it cannot prove hosted notification delivery or
// checkpoint/restore.
const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "wait-stop.fixture.mjs",
);

async function runFixture(format) {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [FIXTURE, format],
    { env: {}, timeout: 60_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1));
}

// The original waiter settled first and the SDK unwound everything it holds.
const woken = {
  originalSettledBeforeTool: true,
  originalPending: false,
  suspendable: [true, false],
  waitHooks: 1,
  resumeHooks: 1,
  usagePausesOpen: 0,
  pauseActive: 1,
  resumeActive: 1,
  slotHeld: false,
};
const stopped = {
  ...woken,
  outcome: "first_stop",
  revalidations: 0,
  resumedEvents: 0,
};
// Stopped before parking: no SDK wait was entered.
const notParked = {
  outcome: "first_stop",
  forTokenCalls: 0,
  suspendable: [],
  waitHooks: 0,
  pauseActive: 0,
  callbackAttempts: 0,
  slotHeld: false,
};
const expected = {
  normal_reply: {
    ...woken,
    outcome: "returned",
    waitOutcome: "message_arrived",
    revalidations: 1,
    resumedEvents: 1,
    callbackAttempts: 0,
    tokenResult: "reply",
  },
  timeout: {
    ...woken,
    outcome: "returned",
    waitOutcome: "timed_out",
    abortRun: ["timed_out"],
    callbackAttempts: 0,
    tokenResult: "timeout",
  },
  stop_before_start: { ...notParked, createTokenCalls: 0, startedEvents: 0 },
  stop_during_acquire: { ...notParked, createTokenCalls: 1, startedEvents: 0 },
  stop_during_prepare: { ...notParked, createTokenCalls: 1 },
  stop_cancel_wins: { ...stopped, callbackAttempts: 1, tokenResult: "marker" },
  stop_during_registration: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "marker",
  },
  stop_reply_wins: { ...stopped, callbackAttempts: 1, tokenResult: "reply" },
  stop_timeout_wins: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "timeout",
  },
  stop_cached_completed: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "reply",
  },
  delayed_notification: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "marker",
    pendingAfterHttpSuccess: true,
  },
  repeated_stop: { ...stopped, callbackAttempts: 1, tokenResult: "marker" },
  callback_rejected: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "reply",
    pendingAfterRejection: true,
  },
  stalled_headers_reply_settles: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "reply",
  },
  response_body_discarded: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "marker",
  },
  unknown_completion_deadline: {
    ...stopped,
    callbackAttempts: 1,
    tokenResult: "marker",
    pendingAfterDeadline: true,
  },
  foreign_callback: {
    ...stopped,
    callbackAttempts: 0,
    tokenResult: "reply",
    pendingWithoutCallback: true,
  },
  stop_during_revalidation: {
    ...stopped,
    revalidations: 1,
    callbackAttempts: 0,
    tokenResult: "reply",
  },
  stop_during_pause: {
    ...notParked,
    createTokenCalls: 1,
    pauseActive: 1,
    resumeActive: 1,
  },
  next_warm_reply: {
    ...woken,
    outcome: "returned",
    waitOutcome: "message_arrived",
    callbackAttempts: 0,
  },
  // Documented limitation: with no notification the original wait remains
  // pending (still suspendable) instead of being raced or reset.
  never_notified: {
    outcome: "pending",
    originalPending: true,
    suspendable: [true],
    usagePausesOpen: 1,
    resumeActive: 0,
    slotHeld: true,
    callbackAttempts: 1,
    tokenResult: "marker",
  },
};

const pick = (result, keys) =>
  Object.fromEntries(keys.map((key) => [key, result[key]]));

for (const format of ["esm", "cjs"])
  test(
    `installed SDK ${format}: a stop wakes the original wait and throws the first reason`,
    { timeout: 90_000 },
    async (t) => {
      const report = await runFixture(format);
      assert.equal(report.format, format);
      assert.deepEqual(
        report.results.map((r) => r.name),
        Object.keys(expected),
      );
      for (const r of report.results)
        await t.test(r.name, () => {
          assert.equal(r.harnessError, null);
          assert.equal(r.unhandled, 0);
          assert.equal(r.deliveryFailed, false);
          assert.deepEqual(
            pick(r, Object.keys(expected[r.name])),
            expected[r.name],
          );
          if (r.callbackAttempts === 0) return;
          // One bounded, untraced POST of the closed marker on its own signal.
          assert.deepEqual(r.callback, {
            method: "POST",
            redirect: "error",
            contentType: "application/json",
            bodyIsMarker: true,
            bodyBytes: report.markerBytes,
            suppressed: true,
            signalIsProduct: false,
            signalAbortedAtCall: false,
            // Only a request still open when the wait settles, or one past its
            // deadline, is aborted.
            abortedWhileOpen: [
              "stalled_headers_reply_settles",
              "unknown_completion_deadline",
            ].includes(r.name),
            bodyCancelled: r.name === "response_body_discarded",
          });
        });
    },
  );
