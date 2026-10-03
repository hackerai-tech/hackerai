// Exercise the production cumulative settlement transaction against isolated Redis.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const source = readFileSync(
  new URL("../lib/rate-limit/free-cost-budget.ts", import.meta.url),
  "utf8",
);
const lua = source.match(/const SETTLE_DAILY_COST = `([\s\S]*?)`;/)?.[1];
assert.ok(lua);
const dir = mkdtempSync(join(tmpdir(), "free-daily-ledger-"));
const socket = join(dir, "redis.sock");
const server = spawn(
  "redis-server",
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
server.on("error", (error) => (startupError = error));
const command = (...args) =>
  JSON.parse(
    execFileSync("redis-cli", ["-s", socket, "--json", ...args.map(String)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
const expiry = Date.now() + 86400000;
const settle = (attempt, target, daily = "day:original", monthly = "month") =>
  command(
    "EVAL",
    lua,
    3,
    daily,
    monthly,
    `settlement:${attempt}`,
    target,
    expiry,
    expiry,
  );
try {
  for (let i = 0; i < 100; i++) {
    if (startupError) throw startupError;
    try {
      if (command("PING") === "PONG") break;
    } catch {}
    if (i === 99) throw new Error("Local Redis failed to start");
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(settle("one", 300), 300);
  assert.equal(settle("one", 300), 300); // lost-response retry
  assert.equal(settle("one", 200), 300); // lower estimate cannot refund spend
  assert.equal(settle("two", 200), 200); // another run during an approval wait
  assert.equal(settle("one", 600), 600); // resume settles just the delta
  assert.equal(command("GET", "day:original"), "800");
  assert.equal(command("GET", "month"), "800");
  settle("tomorrow", 100, "day:next");
  settle("one", 650); // late settlement remains in original bucket
  assert.equal(command("GET", "day:original"), "850");
  assert.equal(command("GET", "day:next"), "100");
  assert.equal(command("GET", "month"), "950");
  assert.ok(command("PTTL", "day:original") > 0);
  command("SET", "bad-month", "invalid");
  try {
    settle("bad", 100, "bad-day", "bad-month");
  } catch {}
  assert.equal(command("GET", "bad-day"), null); // validate before any mutation
  assert.equal(command("GET", "settlement:bad"), null);
  console.log(
    "PASS cumulative daily/monthly settlement, retries, concurrent runs, rollover, and corrupt-ledger isolation",
  );
} finally {
  try {
    command("SHUTDOWN", "NOSAVE");
  } catch {}
  server.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
}
