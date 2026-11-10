/** @jest-environment node */
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  classifyHttpRetest,
  parseHttpRetestRecipe,
  type HttpRetestRecipe,
} from "../http-retest";
import {
  HTTP_RETEST_COMMAND,
  runHttpRetestInSandbox,
} from "../http-retest-runner";

// Real HTTP: a loopback fixture with an own-record endpoint and a victim
// endpoint whose behavior each test selects. The fixed Python runner is
// executed through a real shell, exactly as the sandbox would run it.
const TOKEN = "tester-secret-7f3a9c";
let mode:
  | "vulnerable"
  | "fixed"
  | "expired"
  | "redirect"
  | "oversized"
  | "unexpected"
  | "wrong_owner" = "vulnerable";
const seenAuthorization: string[] = [];
let server: Server;
let origin: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuthorization.push(req.headers.authorization ?? "");
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}` || mode === "expired")
      return json(401, { error: "unauthorized" });
    if (req.url === "/api/invoices/inv_1002")
      return json(200, {
        id: "inv_1002",
        owner_id: mode === "wrong_owner" ? "usr_other" : "usr_tester_b",
        secret_note: "TESTER-PRIVATE-BODY",
      });
    if (req.url === "/api/invoices/inv_1001") {
      if (mode === "fixed") return json(403, { error: "forbidden" });
      if (mode === "unexpected") return json(500, { error: "boom" });
      if (mode === "redirect") {
        res.writeHead(302, { Location: "http://169.254.169.254/" });
        return res.end();
      }
      if (mode === "oversized") {
        res.writeHead(200, { "Content-Type": "text/plain" });
        return res.end("x".repeat(1_200_000));
      }
      return json(200, {
        id: "inv_1001",
        owner_id: "usr_victim_a",
        card_last4: "VICTIM-PRIVATE-BODY",
      });
    }
    json(404, {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const recipeFor = (target: string): HttpRetestRecipe => {
  const parsed = parseHttpRetestRecipe({
    version: 1,
    title: "Invoice IDOR",
    origin: target,
    timeout_ms: 2000,
    credentials: [
      { name: "tester_token", label: "Tester token", placement: "bearer" },
    ],
    baselines: [
      {
        label: "Own invoice",
        method: "GET",
        path: "/api/invoices/inv_1002",
        credential: "tester_token",
        headers: [],
        expect: {
          status: 200,
          json: [{ json_path: "owner_id", equals: "usr_tester_b" }],
          body_contains: [],
        },
      },
    ],
    probe: {
      label: "Victim invoice",
      method: "GET",
      path: "/api/invoices/inv_1001",
      credential: "tester_token",
      headers: [],
      vulnerable: {
        status: 200,
        json: [{ json_path: "owner_id", equals: "usr_victim_a" }],
        body_contains: [],
      },
      not_reproduced: { statuses: [403, 404] },
    },
  });
  if (!parsed.success) throw new Error(parsed.message);
  return parsed.recipe;
};

type Shell = { command: string; stdout: string; exitCode: number };
const executed: Shell[] = [];

const shell = (
  command: string,
  input: { stdin?: string; env?: Record<string, string> },
) =>
  new Promise<Shell>((resolve) => {
    const child = spawn("sh", ["-c", command], {
      env: { PATH: process.env.PATH ?? "", ...input.env },
    });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.on("close", (code) => {
      const result = { command, stdout, exitCode: code ?? 1 };
      executed.push(result);
      resolve(result);
    });
    child.stdin.end(input.stdin ?? "");
  });

/** Local relay adapter: credentials arrive on stdin. */
const localSandbox = () =>
  ({
    sandboxKind: "centrifugo",
    isWindows: () => false,
    supportsCommandStdin: () => true,
    commands: {
      run: (command: string, opts: { stdin?: string }) =>
        shell(command, { stdin: opts.stdin }),
    },
  }) as any;

/** Cloud adapter: credentials arrive in one process environment variable. */
const cloudSandbox = () =>
  ({
    commands: {
      run: async (command: string, opts: { envs?: Record<string, string> }) => {
        const result = await shell(command, { env: opts.envs });
        // E2B raises on a non-zero exit with the result attached.
        if (result.exitCode !== 0)
          throw Object.assign(new Error("exit"), result);
        return result;
      },
    },
  }) as any;

const run = async (sandbox = localSandbox(), target = origin) => {
  const recipe = recipeFor(target);
  const result = await runHttpRetestInSandbox({
    sandbox,
    recipe,
    credentials: { tester_token: TOKEN },
  });
  if (result.kind !== "observed") return { result, classification: null };
  return {
    result,
    classification: classifyHttpRetest(recipe, result.output),
  };
};

describe("fixed Python HTTP retest runner", () => {
  it("reproduces the IDOR over real HTTP and stores no body or secret", async () => {
    mode = "vulnerable";
    seenAuthorization.length = 0;
    const { result, classification } = await run();
    expect(classification).toEqual({
      outcome: "reproduced",
      reason: "vulnerable_predicate_matched",
    });
    expect(seenAuthorization).toEqual([`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("PRIVATE-BODY");
    expect(serialized).toMatch(/"body_sha256":"[0-9a-f]{64}"/);
    // The credential is never part of the executed command line.
    expect(HTTP_RETEST_COMMAND).not.toContain(TOKEN);
    expect(executed.at(-1)?.command).not.toContain(TOKEN);
    expect(executed.at(-1)?.stdout).not.toContain(TOKEN);
  });

  it("reports not reproduced only for the explicit denial status", async () => {
    mode = "fixed";
    expect((await run()).classification).toEqual({
      outcome: "not_reproduced",
      reason: "nonreproduction_predicate_matched",
    });
  });

  it("skips an expired token instead of treating 401 as fixed", async () => {
    mode = "expired";
    expect((await run()).classification).toEqual({
      outcome: "skipped",
      reason: "auth_rejected",
    });
  });

  it("does not send the probe when the baseline returns another identity", async () => {
    mode = "wrong_owner";
    seenAuthorization.length = 0;
    expect((await run()).classification).toEqual({
      outcome: "skipped",
      reason: "baseline_mismatch",
    });
    expect(seenAuthorization).toHaveLength(1);
  });

  it("refuses redirects and oversized or unexpected responses", async () => {
    mode = "redirect";
    expect((await run()).classification).toEqual({
      outcome: "skipped",
      reason: "redirect_refused",
    });
    mode = "oversized";
    expect((await run()).classification).toEqual({
      outcome: "skipped",
      reason: "response_too_large",
    });
    mode = "unexpected";
    expect((await run()).classification).toEqual({
      outcome: "skipped",
      reason: "unexpected_response",
    });
  });

  it("reports an unreachable target as an error", async () => {
    const closed = createServer();
    await new Promise<void>((resolve) =>
      closed.listen(0, "127.0.0.1", resolve),
    );
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(
      (await run(localSandbox(), `http://127.0.0.1:${port}`)).classification,
    ).toEqual({
      outcome: "error",
      reason: "target_unreachable",
    });
  });

  it("runs the same program in cloud mode with the input in one env variable", async () => {
    mode = "vulnerable";
    const { result, classification } = await run(cloudSandbox());
    expect(classification?.outcome).toBe("reproduced");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports an unsupported local client as unavailable without executing", async () => {
    const before = executed.length;
    const sandbox = { ...localSandbox(), supportsCommandStdin: () => false };
    expect((await run(sandbox)).result).toEqual({
      kind: "failed",
      reason: "runtime_unavailable",
    });
    expect(executed.length).toBe(before);
  });

  it("reports a missing Python runtime as unavailable", async () => {
    const sandbox = {
      ...localSandbox(),
      commands: {
        run: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 127 }),
      },
    };
    expect((await run(sandbox)).result).toEqual({
      kind: "failed",
      reason: "runtime_unavailable",
    });
  });
});
