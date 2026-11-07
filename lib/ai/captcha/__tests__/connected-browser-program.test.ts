import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import {
  connectedBrowserCommand,
  connectedBrowserRequest,
} from "../connected-browser-program";

function run(
  request: Record<string, unknown>,
  extraEnv: Record<string, string> = {},
) {
  return new Promise<{ code: number | null; stdout: string }>(
    (resolve, reject) => {
      const child = spawn(connectedBrowserCommand, {
        shell: true,
        env: { ...process.env, ...extraEnv },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.on("data", (data) => {
        stdout += data;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout }));
      child.stdin.on("error", () => {});
      child.stdin.end(connectedBrowserRequest(request));
    },
  );
}

function namespace() {
  const owner = randomBytes(12).toString("hex");
  return {
    owner,
    root: path.join(
      process.platform === "darwin" ? "/tmp" : os.tmpdir(),
      `hackerai-captcha-${owner}`,
    ),
  };
}

it.each(["delivered", "stale", "replaced", "failed"])(
  "delivers managed responses privately and restores the user agent when needed: %s",
  async (outcome) => {
    const { owner, root } = namespace();
    mkdirSync(path.join(root, "sockets"), { recursive: true, mode: 0o700 });
    const calls: Array<{ id: string; action: string; userAgent?: string }> = [];
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", (bytes) => {
        const command = JSON.parse(bytes.toString());
        calls.push(command);
        const result =
          command.id === "captcha-identity"
            ? outcome !== "stale"
            : command.id === "captcha-deliver"
              ? {
                  status:
                    outcome === "replaced" ? "page_changed" : "token_delivered",
                }
              : undefined;
        socket.end(
          JSON.stringify({
            success: !(
              outcome === "failed" && command.id === "captcha-deliver"
            ),
            data: { result },
          }) + "\n",
        );
      });
    });
    try {
      if (process.platform === "win32") {
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        writeFileSync(
          path.join(root, "sockets", "owned.port"),
          String((server.address() as { port: number }).port),
        );
      } else {
        server.listen(path.join(root, "sockets", "owned.sock"));
        await once(server, "listening");
      }
      const result = await run({
        action: "cloudflare",
        owner,
        expiresAt: Date.now() + 30000,
        sessionName: "owned",
        identityScript: "true",
        script: "private-response-token",
        userAgent: "solver-agent",
        originalUserAgent: "original-agent",
      });
      expect(result.stdout).not.toContain("private-response-token");
      expect(result.stdout).not.toContain("solver-agent");
      expect(result.code).toBe(outcome === "failed" ? 1 : 0);
      expect(calls.map((c) => c.id)).toEqual(
        outcome === "stale"
          ? ["captcha-identity"]
          : [
              "captcha-identity",
              "captcha-useragent",
              "captcha-deliver",
              ...(outcome === "delivered" ? [] : ["captcha-restore-useragent"]),
            ],
      );
      if (outcome === "replaced" || outcome === "failed")
        expect(calls.at(-1)?.userAgent).toBe("original-agent");
      if (outcome === "delivered")
        expect(JSON.parse(result.stdout).result.status).toBe("token_delivered");
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);

it("rejects invalid deadlines and inherited user profiles before creating ownership", async () => {
  for (const input of [
    { expiresAt: Date.now() + 25 * 60 * 60 * 1000, env: {} },
    {
      expiresAt: Date.now() + 30_000,
      env: { AGENT_BROWSER_PROFILE: "private-user-profile" },
    },
  ]) {
    const { owner, root } = namespace();
    const result = await run(
      { action: "prepare", owner, expiresAt: input.expiresAt },
      input.env,
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("private-user-profile");
    expect(existsSync(root)).toBe(false);
  }
  expect(connectedBrowserCommand.length).toBeLessThan(1024);
});

(process.platform === "win32" ? it.skip : it)(
  "retains a hung daemon's namespace and permits bounded cleanup recovery",
  async () => {
    const { owner, root } = namespace();
    mkdirSync(path.join(root, "sockets"), { recursive: true, mode: 0o700 });
    let attempt = 0;
    const server = createServer((socket) => {
      socket.on("error", () => {});
      socket.once("data", () => {
        if (++attempt > 1) socket.end('{"success":true}\n');
      });
    });
    try {
      await new Promise<void>((resolve) =>
        server.listen(
          path.join(root, "sockets", `captcha-${owner}.sock`),
          resolve,
        ),
      );
      expect(
        (await run({ action: "cleanup", owner, expiresAt: Date.now() })).code,
      ).toBe(1);
      expect(existsSync(root)).toBe(true);
      expect(
        (await run({ action: "cleanup", owner, expiresAt: Date.now() })).code,
      ).toBe(0);
      expect(existsSync(root)).toBe(false);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

(process.platform === "win32" ? it.skip : it)(
  "inspects a named owned browser, refuses ambiguity, and closes every owned daemon",
  async () => {
    const { owner, root } = namespace();
    mkdirSync(path.join(root, "sockets"), { recursive: true, mode: 0o700 });
    const calls: string[] = [];
    const servers = [];
    try {
      for (const name of ["custom-session", "second-session"]) {
        const server = createServer((socket) => {
          socket.on("error", () => {});
          socket.once("data", (bytes) => {
            calls.push(name + ":" + JSON.parse(bytes.toString()).action);
            socket.end('{"success":true,"data":{"result":"observed"}}\n');
          });
        });
        servers.push(server);
        server.listen(path.join(root, "sockets", name + ".sock"));
        await once(server, "listening");
        if (servers.length === 1) {
          expect(
            (
              await run({
                action: "evaluate",
                owner,
                expiresAt: Date.now() + 30_000,
                script: "document.title",
                sessionName: "snapshot-that-was-closed",
              })
            ).code,
          ).toBe(1);
          expect(calls).toEqual([]);
        }
        const result = await run({
          action: "evaluate",
          owner,
          expiresAt: Date.now() + 30_000,
          script: "document.title",
          sessionName: "custom-session",
        });
        expect(result.code).toBe(servers.length === 1 ? 0 : 1);
      }
      expect(calls).toEqual(["custom-session:evaluate"]);
      expect(
        (await run({ action: "cleanup", owner, expiresAt: Date.now() })).code,
      ).toBe(0);
      expect(calls.slice(1).sort()).toEqual([
        "custom-session:close",
        "second-session:close",
      ]);
      expect(existsSync(root)).toBe(false);
    } finally {
      for (const server of servers) server.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
