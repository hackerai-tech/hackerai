#!/usr/bin/env node
// Runs the actual production Lua transactions against an isolated local Redis.
// No application credentials, cloud deployment, or customer data are used.
import assert from "node:assert/strict";
import { execFileSync, execFile, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const bucketSource = readFileSync(
  join(root, "lib/rate-limit/token-bucket.ts"),
  "utf8",
);
const limitSource = readFileSync(
  join(root, "lib/rate-limit/paid-bucket.ts"),
  "utf8",
);
const script = (source, name) => {
  const match = source.match(
    new RegExp(`const ${name} = \u0060([\\s\\S]*?)\u0060;`),
  );
  assert.ok(match, `Missing production script ${name}`);
  return match[1];
};
const limitLua = script(limitSource, "PAID_BUCKET_LIMIT_SCRIPT");
const paidLua = script(bucketSource, "APPLY_PAID_BUCKET_RESET_SCRIPT");
const holdLua = script(bucketSource, "FREEZE_DELINQUENT_BUCKET_SCRIPT");
const initLua = script(bucketSource, "SET_MONTHLY_BUCKET_STATE_SCRIPT");
const directory = mkdtempSync(join(tmpdir(), "paid-ledger-"));
const socket = join(directory, "redis.sock");
const redisCli = process.env.REDIS_CLI_BIN ?? "redis-cli";
const server = spawn(
  process.env.REDIS_SERVER_BIN ?? "redis-server",
  [
    "--port",
    "0",
    "--unixsocket",
    socket,
    "--unixsocketperm",
    "700",
    "--save",
    "",
    "--appendonly",
    "no",
  ],
  { stdio: "ignore" },
);
let startupError;
server.on("error", (error) => {
  startupError = error;
});
const command = (...args) =>
  JSON.parse(
    execFileSync(redisCli, ["-s", socket, "--json", ...args.map(String)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
const evalLua = (lua, key, args) => command("EVAL", lua, 1, key, ...args);
const day = 86400000;
const start = Date.UTC(2026, 8, 1);
const paid = (key, at, end, invoice = "in_current", allocation = 250000) =>
  evalLua(paidLua, key, [
    allocation,
    allocation,
    250000,
    at,
    end > 0 ? end - 30 * day : at,
    35 * 86400,
    at,
    "sub_current",
    invoice,
    end,
  ]);
const limit = (key, at, debit = 0) =>
  evalLua(limitLua, key, [250000, 30 * day, at, debit]);
let cases = 0;
const check = async (name, test) => {
  await test();
  cases++;
  console.log(`PASS ${name}`);
};

try {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startupError) throw startupError;
    try {
      if (command("PING") === "PONG") break;
    } catch {}
    if (attempt === 99) throw new Error("Local Redis did not start");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await check(
    "late payment restores full allowance once without moving its deadline",
    () => {
      const key = "late";
      command(
        "HSET",
        key,
        "tokens",
        5000,
        "cycleAllocation",
        250000,
        "refilledAt",
        start,
      );
      evalLua(holdLua, key, [
        250000,
        start + day,
        start + day,
        35 * 86400,
        "sub_current",
        "in_current",
      ]);
      assert.equal(limit(key, start + 2 * day, 3000)[1], 2000);
      assert.deepEqual(paid(key, start + 4 * day, start + 31 * day), [
        1,
        1,
        start + day,
      ]);
      assert.deepEqual(limit(key, start + 4 * day, 25000), [
        1,
        225000,
        start + 31 * day,
        250000,
      ]);
      assert.equal(paid(key, start + 4 * day, start + 31 * day)[0], 2);
      assert.equal(limit(key, start + 5 * day)[1], 225000);
      assert.equal(command("TTL", key), -1);
    },
  );
  await check(
    "paying an expired period does not create a fresh 30-day allowance",
    () => {
      const key = "expired-payment";
      paid(key, start + 40 * day, start + 31 * day);
      assert.deepEqual(limit(key, start + 40 * day, 1), [
        0,
        0,
        start + 31 * day,
        250000,
      ]);
      assert.equal(limit(key, start + 100 * day)[1], 0);
      assert.equal(paid(key, start + 40 * day, start + 31 * day)[0], 2);
      assert.equal(limit(key, start + 100 * day)[1], 0);
    },
  );
  for (const days of [28, 29, 30, 31]) {
    await check(
      `${days}-day paid month expires without minting an unpaid allowance`,
      () => {
        const key = `month-${days}`;
        paid(key, start, start + days * day);
        assert.equal(limit(key, start + day, 150000)[1], 100000);
        assert.equal(limit(key, start + days * day - 1)[1], 100000);
        assert.deepEqual(limit(key, start + days * day, 1), [
          0,
          0,
          start + days * day,
          250000,
        ]);
        assert.equal(limit(key, start + 100 * day)[1], 0);
        assert.equal(command("TTL", key), -1);
      },
    );
  }
  await check(
    "delinquency holds preserve subsequent spending after 45 days and retries",
    () => {
      const key = "hold";
      command(
        "HSET",
        key,
        "tokens",
        10000,
        "cycleAllocation",
        250000,
        "refilledAt",
        start,
      );
      evalLua(holdLua, key, [
        250000,
        start,
        start,
        35 * 86400,
        "sub_current",
        "in_failed",
      ]);
      limit(key, start + day, 7000);
      assert.equal(limit(key, start + 45 * day)[1], 3000);
      assert.equal(
        evalLua(holdLua, key, [
          250000,
          start + 46 * day,
          start + 46 * day,
          35 * 86400,
          "sub_current",
          "in_failed",
        ])[0],
        2,
      );
      assert.equal(limit(key, start + 90 * day)[1], 3000);
      assert.equal(command("TTL", key), -1);
    },
  );
  await check("rejected debit leaves included credits intact", () => {
    paid("reject", start, start + 31 * day, "in_reject", 50);
    assert.deepEqual(limit("reject", start, 70), [0, 50, start + 31 * day, 50]);
    assert.equal(limit("reject", start, 30)[1], 20);
  });
  await check("parallel debits spend the allowance exactly once", async () => {
    paid("concurrent", start, start + 31 * day, "in_parallel", 100);
    const run = promisify(execFile);
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        run(redisCli, [
          "-s",
          socket,
          "--json",
          "EVAL",
          limitLua,
          "1",
          "concurrent",
          "250000",
          String(30 * day),
          String(start),
          "10",
        ]).then(({ stdout }) => JSON.parse(stdout)),
      ),
    );
    assert.equal(results.filter(([success]) => success === 1).length, 10);
    assert.equal(command("HGET", "concurrent", "tokens"), "0");
  });
  await check("older payment cannot clear a newer failed renewal", () => {
    paid("stale", start, start + 31 * day);
    evalLua(holdLua, "stale", [
      250000,
      start + 31 * day,
      start + 31 * day,
      35 * 86400,
      "sub_current",
      "in_new",
    ]);
    assert.equal(paid("stale", start + day, start + 31 * day)[0], 0);
    assert.equal(command("HGET", "stale", "billingInvoiceId"), "in_new");
  });
  await check(
    "annual buckets retain the existing monthly allowance schedule",
    () => {
      paid("annual", start, 0);
      limit("annual", start, 150000);
      assert.equal(limit("annual", start + 30 * day)[1], 250000);
    },
  );
  await check(
    "prorated monthly initialization retains its payment deadline",
    () => {
      evalLua(initLua, "proration", [
        120000,
        200000,
        250000,
        start,
        start + day - 30 * day,
        35 * 86400,
        start + day,
      ]);
      assert.deepEqual(limit("proration", start, 10000), [
        1,
        110000,
        start + day,
        200000,
      ]);
      assert.equal(limit("proration", start + day)[1], 0);
    },
  );
  console.log(`${cases} real Redis ledger scenarios passed`);
} finally {
  try {
    command("SHUTDOWN", "NOSAVE");
  } catch {}
  if (server.exitCode === null) server.kill("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
}
