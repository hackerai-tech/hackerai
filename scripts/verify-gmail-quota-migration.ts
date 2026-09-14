/** Real Redis verification, isolated on a temporary Unix socket. No cloud access. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "redis";
import { Redis } from "@upstash/redis";
import { createServer } from "node:http";
import {
  runQuotaMigration,
  type MigrationCommand,
} from "../lib/rate-limit/quota-migration-runner";
import {
  FREE_QUOTA_MIGRATION_STATE,
  freeQuotaRedirectKey,
  MIGRATE_FREE_QUOTA_ALIAS_SCRIPT,
  resolveMigratedFreeQuotaSubject,
} from "../lib/rate-limit/free-quota-migration";
import {
  createFreeQuotaSubjectWithSecret as legacy,
  createCanonicalFreeQuotaSubjectWithSecret as canonical,
} from "../lib/auth/free-quota-subject-core";

async function main() {
  const dir = await mkdtemp(join(tmpdir(), "gmail-quota-test-"));
  const socket = join(dir, "redis.sock");
  const child = spawn(
    "redis-server",
    ["--port", "0", "--unixsocket", socket, "--save", "", "--appendonly", "no"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const client = createClient({
    socket: { path: socket, reconnectStrategy: false },
  });
  const childClosed = new Promise<void>((resolve) =>
    child.once("close", () => resolve()),
  );
  client.on("error", () => {});
  let pauseBeforeNextAdmission = false;
  let staleRedirectReads = false;
  const bridge = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const command = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("Content-Type", "application/json");
      const encode = (value: unknown): unknown =>
        Array.isArray(value)
          ? value.map(encode)
          : typeof value === "string" &&
              value !== "OK" &&
              req.headers["upstash-encoding"] === "base64"
            ? Buffer.from(value).toString("base64")
            : value;
      const run = async (parts: unknown[]) => {
        if (
          staleRedirectReads &&
          String(parts[0]).toLowerCase() === "get" &&
          String(parts[1]).startsWith("free_quota_gmail_migration:v1:redirect:")
        )
          return { result: null };
        if (
          pauseBeforeNextAdmission &&
          String(parts[0]).toLowerCase() === "eval" &&
          String(parts[1]).includes("local migrationState")
        ) {
          pauseBeforeNextAdmission = false;
          await client.set(FREE_QUOTA_MIGRATION_STATE, "paused");
        }
        try {
          return {
            result: encode(await client.sendCommand(parts.map(String))),
          };
        } catch (error) {
          return { error: String(error) };
        }
      };
      res.end(
        JSON.stringify(
          Array.isArray(command[0])
            ? await Promise.all(command.map(run))
            : await run(command),
        ),
      );
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "Redis command failed" }));
    }
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("Redis startup timed out")),
        10000,
      );
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", () => {
        clearTimeout(timer);
        reject(new Error("Redis exited before verification completed"));
      });
      child.stdout.on("data", (chunk) => {
        if (
          String(chunk).toLowerCase().includes("ready to accept connections")
        ) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await client.connect();
    await new Promise<void>((resolve) =>
      bridge.listen(0, "127.0.0.1", resolve),
    );
    const address = bridge.address() as { port: number };
    process.env.UPSTASH_REDIS_REST_URL = `http://127.0.0.1:${address.port}`;
    process.env.UPSTASH_REDIS_REST_TOKEN = "local-test-only";
    process.env.FREE_QUOTA_GMAIL_CANONICALIZATION = "true";
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: "local-test-only",
      enableAutoPipelining: false,
    });
    const source = legacy("f.irst+one@gmail.com", "test")!;
    const other = legacy("fi.rst+two@googlemail.com", "test")!;
    const target = canonical("first@gmail.com", "test")!;
    const day = Math.floor(Date.now() / 86400000);
    const month = new Date().toISOString().slice(0, 7);
    const counters = (subject: string) => [
      `free_limit:${subject}:free:${day}`,
      `free_monthly_cost:${subject}:${month}`,
      `free_referral_bonus:${subject}`,
      `free_referral_bonus_grant:referral_signup:${subject}`,
    ];
    const destination = counters(target);
    const migrate = async (subject: string) =>
      redis.eval(
        MIGRATE_FREE_QUOTA_ALIAS_SCRIPT,
        [
          FREE_QUOTA_MIGRATION_STATE,
          freeQuotaRedirectKey(subject),
          ...counters(subject).flatMap((key, i) => [key, destination[i]]),
        ],
        [target, "counter", "counter", "counter", "marker"],
      );
    await client.set(FREE_QUOTA_MIGRATION_STATE, "paused");
    await assert.rejects(resolveMigratedFreeQuotaSubject(redis, source));
    for (const subject of [source, other, target]) {
      for (const [i, key] of counters(subject).entries())
        await client.set(key, String([4, 900, 2, 1][i]), { PX: 60000 });
    }
    await migrate(source);
    await migrate(other);
    await migrate(source); // Network retry must not double-count.
    assert.deepEqual(await client.mGet(destination), ["12", "2700", "6", "1"]);
    assert.ok((await client.pTTL(destination[0])) <= 60000);
    assert.ok((await client.pTTL(destination[0])) > 0);
    assert.equal(await client.get(counters(source)[0]), null);
    assert.equal(
      await resolveMigratedFreeQuotaSubject(redis, source, true),
      target,
    );
    await client.set(FREE_QUOTA_MIGRATION_STATE, "complete");
    // Simulate callers that resolved their subject before cutover. Every
    // transaction must still use the canonical key with stale outer reads.
    staleRedirectReads = true;
    // Exercise actual runtime consumers using the local REST bridge.
    const {
      checkFreeUserRateLimit,
      checkFreeAgentRateLimit,
      grantFreeReferralBonusUnits,
    } = await import("../lib/rate-limit/sliding-window");
    const { checkFreeMonthlyCostLimit, recordFreeMonthlyCost } =
      await import("../lib/rate-limit/free-monthly-cost");
    const { acquireFreeRunConcurrencyLock } =
      await import("../lib/rate-limit/free-concurrency");
    await assert.rejects(
      checkFreeMonthlyCostLimit(source, {
        dailyRequests: 10,
        monthlyCostDollars: 0.25,
      }),
    );
    await recordFreeMonthlyCost(source, 0.01);
    assert.equal(await client.get(destination[1]), "2800");
    const expandedBudget = {
      dailyRequests: 10,
      monthlyCostDollars: 0.5,
      monthlyBudgetExperiment: "free_monthly_budget_v1" as const,
    };
    const ttlBeforeBudgetChange = await client.pTTL(destination[1]);
    const expandedSnapshot = await checkFreeMonthlyCostLimit(
      source,
      expandedBudget,
    );
    assert.equal(expandedSnapshot.monthlyRemainingAtStart, 2200);
    assert.equal(await client.get(destination[1]), "2800");
    assert.ok((await client.pTTL(destination[1])) <= ttlBeforeBudgetChange);
    // Disable/re-enable the experiment: usage and reset stay in the same key.
    await assert.rejects(checkFreeMonthlyCostLimit(other));
    assert.equal(
      (await checkFreeMonthlyCostLimit(other, expandedBudget))
        .monthlyRemainingAtStart,
      2200,
    );
    await recordFreeMonthlyCost(other, 0.22);
    assert.equal(await client.get(destination[1]), "5000");
    await assert.rejects(checkFreeMonthlyCostLimit(target, expandedBudget));
    for (let i = 0; i < 6; i++)
      await (i % 2
        ? checkFreeAgentRateLimit(source)
        : checkFreeUserRateLimit(other));
    await assert.rejects(checkFreeUserRateLimit(target));
    // A higher monthly budget must not grant more daily units or referrals.
    await assert.rejects(
      checkFreeUserRateLimit(target, 1, expandedBudget),
      (error: unknown) =>
        (error as { metadata?: { capReason?: string } }).metadata?.capReason ===
        "daily_requests_exhausted",
    );
    assert.equal(
      (
        await grantFreeReferralBonusUnits(
          source,
          20,
          `referral_signup:${source}`,
        )
      ).alreadyGranted,
      true,
    );
    const lock = await acquireFreeRunConcurrencyLock(other);
    await assert.rejects(acquireFreeRunConcurrencyLock(source));
    await lock.release();
    await (await acquireFreeRunConcurrencyLock(target)).release();
    for (const admit of [
      () => checkFreeUserRateLimit(target),
      () => grantFreeReferralBonusUnits(target, 20, "race-test"),
      () => acquireFreeRunConcurrencyLock(target),
    ]) {
      await client.set(FREE_QUOTA_MIGRATION_STATE, "complete");
      pauseBeforeNextAdmission = true;
      await assert.rejects(admit(), (error: unknown) =>
        `${String(error)} ${String((error as { cause?: unknown }).cause)}`.includes(
          "Free quota migration paused",
        ),
      );
      assert.equal(await client.get(`free_run_lock:${target}`), null);
      assert.equal(
        await client.get(`free_referral_bonus_grant:race-test`),
        null,
      );
    }
    await client.set(FREE_QUOTA_MIGRATION_STATE, "paused");
    await client.set(counters(source)[0], "3");
    await client.set(counters(source)[1], "corrupt");
    const before = await client.get(destination[0]);
    await assert.rejects(migrate(source));
    assert.equal(
      await client.get(destination[0]),
      before,
      "validation must precede all writes",
    );
    assert.equal(await client.get(counters(source)[0]), "3");
    // Exercise the operator CLI as well as its Lua transaction.
    await client.flushDb(); // This process owns this disposable Redis instance.
    const inventory = join(dir, "inventory.json");
    await writeFile(
      inventory,
      JSON.stringify([
        "f.irst+one@gmail.com",
        "fi.rst+two@googlemail.com",
        "first@gmail.com",
      ]),
      { mode: 0o600 },
    );
    const cli = async (action: string, extra: string[] = []) =>
      new Promise<number | null>((resolve, reject) => {
        const run = spawn(
          "pnpm",
          [
            "exec",
            "tsx",
            "scripts/migrate-gmail-free-quotas.ts",
            "--action",
            action,
            "--emails",
            inventory,
            "--expected-redis-host",
            "127.0.0.1",
            ...extra,
          ],
          {
            env: { ...process.env, ACCOUNT_IDENTITY_HMAC_SECRET: "test" },
            stdio: "ignore",
          },
        );
        run.once("error", reject);
        run.once("exit", resolve);
      });
    await client.set(counters(source)[0], "3", { PX: 60000 });
    assert.equal(
      await cli("apply", [
        "--all-free-runs-drained",
        "--canonical-runtimes-ready",
      ]),
      1,
    );
    assert.equal(await cli("pause"), 0);
    await client.set("free_run_lock:old-worker", "active", { PX: 60000 });
    assert.equal(
      await cli("apply", [
        "--all-free-runs-drained",
        "--canonical-runtimes-ready",
      ]),
      1,
    );
    await client.del("free_run_lock:old-worker");
    await client.set(
      `free_limit:free_quota:v1:${"f".repeat(64)}:free:${day}`,
      "1",
      { PX: 60000 },
    );
    assert.equal(
      await cli("apply", [
        "--all-free-runs-drained",
        "--canonical-runtimes-ready",
      ]),
      1,
    );
    await client.del(`free_limit:free_quota:v1:${"f".repeat(64)}:free:${day}`);
    assert.equal(
      await cli("apply", [
        "--all-free-runs-drained",
        "--canonical-runtimes-ready",
      ]),
      0,
    );
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "migrated");
    assert.equal(await client.get(destination[0]), "3");
    assert.equal(await cli("pause"), 0);
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "migrated");
    assert.equal(await cli("resume"), 1);
    assert.equal(await cli("resume", ["--canonical-runtimes-ready"]), 0);
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "complete");
    assert.equal(await cli("pause"), 0);
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "migrated");
    assert.equal(await cli("resume", ["--canonical-runtimes-ready"]), 0);
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "complete");
    assert.equal(await client.get(destination[0]), "3");
    // Exercise the hosted runner against real Redis and its actual Lua scripts.
    await client.flushDb(); // This process owns the disposable database.
    const runner = (command: MigrationCommand, canonicalReady = false) =>
      runQuotaMigration(command, {
        redis,
        hmacSecret: "test",
        canonical: canonicalReady,
        listUsers: async () => ({
          emails: ["a.b+one@gmail.com", "ab@gmail.com"],
          after: null,
        }),
      });
    const runnerSource = legacy("a.b+one@gmail.com", "test")!;
    const runnerTarget = canonical("ab@gmail.com", "test")!;
    const sourceCounter = `free_monthly_cost:${runnerSource}:2026-09`;
    const targetCounter = `free_monthly_cost:${runnerTarget}:2026-09`;
    const expiredLegacy = `free_agent_limit:user_${"A".repeat(26)}:free_agent:20000`;
    await client.set(expiredLegacy, "4"); // A retired daily counter without a TTL.
    await client.set(sourceCounter, "15", { PX: 60000 });
    await client.set(targetCounter, "25", { PX: 90000 });
    await runner({ action: "inventory" });
    await client.set("free_limit:unmapped:free:today", "1");
    while (!(await runner({ action: "audit" })).auditComplete) {}
    assert.equal((await runner({ action: "status" })).unknownQuotaKeys, 1);
    await assert.rejects(runner({ action: "pause" }));
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), null);
    await client.del("free_limit:unmapped:free:today");
    await runner({ action: "restart-audit" });
    while (!(await runner({ action: "audit" })).auditComplete) {}
    await runner({ action: "pause" });
    await assert.rejects(runner({ action: "inventory" }));
    await runner({ action: "inventory" }, true);
    await client.set(`free_run_lock:${runnerSource}`, "running");
    while (!(await runner({ action: "audit" }, true)).auditComplete) {}
    const apply: MigrationCommand = {
      action: "apply",
      allFreeRunsDrained: true,
      canonicalRuntimesReady: true,
    };
    await assert.rejects(runner(apply, true));
    await client.del(`free_run_lock:${runnerSource}`);
    await runner({ action: "restart-audit" }, true);
    while (!(await runner({ action: "audit" }, true)).auditComplete) {}
    await assert.rejects(runner({ action: "apply" }, true));
    // Simulate losing the response after transfers but before committing the
    // completed page. Retrying must not add the source usage a second time.
    const realEval = redis.eval.bind(redis);
    let failCommit = true;
    redis.eval = (async (script: string, keys: string[], args: unknown[]) => {
      if (
        failCommit &&
        keys[1] === "free_quota_runtime_migration:v1:meta" &&
        args[2] === "migrated"
      ) {
        failCommit = false;
        throw new Error("Synthetic connection loss before page commit");
      }
      return realEval(script, keys, args);
    }) as typeof redis.eval;
    await assert.rejects(runner(apply, true));
    await assert.rejects(runner({ action: "restart-inventory" }, true));
    redis.eval = realEval;
    while (!(await runner(apply, true)).applied) {}
    assert.equal(await client.get(sourceCounter), null);
    assert.equal(await client.get(targetCounter), "40");
    assert.ok((await client.pTTL(targetCounter)) > 60000);
    assert.equal(
      await client.get(freeQuotaRedirectKey(runnerSource)),
      runnerTarget,
    );
    await assert.rejects(runner({ action: "restart-inventory" }, true));
    await assert.rejects(runner({ action: "resume" }, true));
    await runner({ action: "resume", canonicalRuntimesReady: true }, true);
    assert.equal(await client.get(FREE_QUOTA_MIGRATION_STATE), "complete");
    await runner({ action: "cleanup" }, true);
    assert.equal(await client.get(expiredLegacy), "4");
    assert.equal(await client.ttl(expiredLegacy), -1);
    assert.equal(await client.get(targetCounter), "40");
    assert.equal(
      await client.get(freeQuotaRedirectKey(runnerSource)),
      runnerTarget,
    );
    console.log(
      "PASS: real Redis migration, retry, TTL, old-payload settlement, Ask/Agent budget, referral idempotency, concurrency, fail-closed gate and corrupt-state rejection",
    );
  } finally {
    await new Promise<void>((resolve) => bridge.close(() => resolve()));
    if (client.isOpen) await client.quit();
    child.kill("SIGTERM");
    await childClosed;
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
