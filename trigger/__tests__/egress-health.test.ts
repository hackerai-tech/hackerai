/** @jest-environment node */
jest.mock("@trigger.dev/sdk", () => ({
  schedules: { task: (definition: unknown) => definition },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock("@e2b/code-interpreter", () => ({ Sandbox: { create: jest.fn() } }));
jest.mock("@/lib/rate-limit/redis", () => ({ createRedisClient: jest.fn() }));

import { Sandbox } from "@e2b/code-interpreter";
import { logger } from "@trigger.dev/sdk";
import { createRedisClient } from "@/lib/rate-limit/redis";
import {
  EgressHealthError,
  PROBE_BUDGETS,
  egressHealthEuTask,
  egressHealthUsTask,
  parseTraceIp,
  runEgressHealthCheck,
} from "../egress-health";

const US_IP = "198.51.100.10";
const EU_IP = "198.51.100.20";
const SHARED_IP = "203.0.113.99";
const US_PROXY = {
  address: "us-proxy.example.test:1080",
  username: "us-user",
  password: "us-proxy-secret",
};
const EU_PROXY = {
  address: "eu-proxy.example.test:1080",
  username: "eu-user",
  password: "eu-proxy-secret",
};
const T0 = new Date("2026-11-20T10:00:00.000Z");
const at = (slots: number) => new Date(T0.getTime() + slots * 5 * 60_000);
const trace = (ip: string) =>
  `fl=1f1\nh=${"convex.haiusercontent.com"}\nip=${ip}\nts=1.0\nvisit_scheme=https\n`;

type ScheduledTask = {
  id: string;
  cron: unknown;
  run: (payload: { timestamp: Date }) => Promise<unknown>;
};

const create = jest.mocked(Sandbox.create) as unknown as jest.Mock;
const originalEnv = process.env;
let store: Map<string, string>;
let sandbox: {
  commands: { run: jest.Mock };
  kill: jest.Mock;
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...originalEnv };
  for (const key of [
    "E2B_DOMAIN",
    "E2B_EU_DOMAIN",
    "E2B_TEMPLATE",
    "E2B_EU_TEMPLATE",
    "E2B_MANAGED_EGRESS_USERS",
  ])
    delete process.env[key];
  Object.assign(process.env, {
    E2B_EGRESS_MONITOR_ENABLED: "true",
    E2B_MANAGED_EGRESS_ENABLED: "true",
    E2B_MANAGED_EGRESS_DESTINATIONS: "*",
    E2B_MANAGED_EGRESS_US_PROXY: JSON.stringify(US_PROXY),
    E2B_MANAGED_EGRESS_EU_PROXY: JSON.stringify(EU_PROXY),
    E2B_API_KEY: "us-api-key",
    E2B_EU_API_KEY: "eu-api-key",
    E2B_EGRESS_MONITOR_US_IP: US_IP,
    E2B_EGRESS_MONITOR_EU_IP: EU_IP,
  });

  store = new Map();
  jest.mocked(createRedisClient).mockReturnValue({
    set: jest.fn(
      async (key: string, value: string, opts?: { nx?: boolean }) => {
        if (opts?.nx && store.has(key)) return null;
        store.set(key, value);
        return "OK";
      },
    ),
    exists: jest.fn(
      async (...keys: string[]) => keys.filter((key) => store.has(key)).length,
    ),
    del: jest.fn(
      async (...keys: string[]) =>
        keys.filter((key) => store.delete(key)).length,
    ),
  } as never);

  sandbox = {
    commands: { run: jest.fn().mockResolvedValue({ stdout: trace(US_IP) }) },
    kill: jest.fn().mockResolvedValue(true),
  };
  create.mockResolvedValue(sandbox);
});

afterAll(() => {
  process.env = originalEnv;
});

const loggedText = () =>
  JSON.stringify([
    jest.mocked(logger.info).mock.calls,
    jest.mocked(logger.warn).mock.calls,
    jest.mocked(logger.error).mock.calls,
  ]);

const rejection = async (promise: Promise<unknown>) => {
  const error = await promise.then(
    () => {
      throw new Error("expected rejection");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(EgressHealthError);
  return error as EgressHealthError;
};

describe("egress health schedules", () => {
  it("runs each region every five minutes in Production only, without a window offset", () => {
    for (const task of [egressHealthUsTask, egressHealthEuTask])
      expect((task as unknown as ScheduledTask).cron).toEqual({
        pattern: "*/5 * * * *",
        window: "0m",
        environments: ["PRODUCTION"],
      });
    expect((egressHealthUsTask as unknown as ScheduledTask).id).toBe(
      "egress-health-us",
    );
    expect((egressHealthEuTask as unknown as ScheduledTask).id).toBe(
      "egress-health-eu",
    );
  });

  it.each([
    {
      task: egressHealthUsTask,
      ip: US_IP,
      connection: { apiKey: "us-api-key", domain: "e2b.app" },
      proxy: US_PROXY,
    },
    {
      task: egressHealthEuTask,
      ip: EU_IP,
      connection: { apiKey: "eu-api-key", domain: "e2b-juliett.dev" },
      proxy: EU_PROXY,
    },
  ])(
    "$task.id probes only the owned trace endpoint through its region's proxy with deny-all elsewhere",
    async ({ task, ip, connection, proxy }) => {
      sandbox.commands.run.mockResolvedValue({ stdout: trace(ip) });

      await expect(
        (task as unknown as ScheduledTask).run({ timestamp: T0 }),
      ).resolves.toEqual(expect.objectContaining({ status: "healthy" }));

      expect(create).toHaveBeenCalledTimes(1);
      const [template, options] = create.mock.calls[0];
      expect(template).toBe("terminal-agent-sandbox:v13");
      expect(options).toEqual(
        expect.objectContaining({
          ...connection,
          // General egress ("*") would otherwise map to open internet.
          network: {
            allowOut: ["convex.haiusercontent.com"],
            denyOut: ["0.0.0.0/0"],
            egressProxy: proxy,
          },
          retries: 0,
          lifecycle: { onTimeout: "kill" },
          timeoutMs: PROBE_BUDGETS.sandboxTtlMs,
        }),
      );
      expect(Object.keys(options.metadata)).toEqual(["purpose"]);

      expect(sandbox.commands.run).toHaveBeenCalledTimes(1);
      const command: string = sandbox.commands.run.mock.calls[0][0];
      expect(command.match(/https?:\/\/\S+/g)).toEqual([
        "https://convex.haiusercontent.com/cdn-cgi/trace",
      ]);
      expect(command).toMatch(/^curl /);
      expect(command).toContain("--proto =https");
      expect(command).toContain("--max-redirs 0");
      expect(command).toContain(`--max-time ${PROBE_BUDGETS.curlMaxTimeS}`);
      expect(command).toContain(
        `--max-filesize ${PROBE_BUDGETS.maxResponseBytes}`,
      );
      expect(command).not.toMatch(/(^|\s)(-L|--location)(\s|$)/);
      expect(sandbox.kill).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps the probe narrow when the operator destinations list is broader", async () => {
    process.env.E2B_MANAGED_EGRESS_DESTINATIONS =
      "api.example.test,convex.haiusercontent.com";

    await runEgressHealthCheck("us", T0);

    expect(create.mock.calls[0][1].network.allowOut).toEqual([
      "convex.haiusercontent.com",
    ]);
  });
});

describe("source IP assertion", () => {
  it("fails immediately on an unexpected IP, cleans up and logs no raw values", async () => {
    sandbox.commands.run.mockResolvedValue({ stdout: trace(SHARED_IP) });

    const error = await rejection(runEgressHealthCheck("us", T0));

    expect(error.reasons).toEqual(["wrong_ip"]);
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    const surfaced = `${error.message}${loggedText()}`;
    for (const value of [
      SHARED_IP,
      US_IP,
      US_PROXY.password,
      US_PROXY.address,
      "us-api-key",
    ])
      expect(surfaced).not.toContain(value);
  });

  it.each([
    ["two ip lines", `${trace(US_IP)}ip=${US_IP}\n`],
    ["no ip line", "fl=1f1\nvisit_scheme=https\n"],
    ["an IPv6 address", trace("2001:db8::1")],
    ["a non-canonical address", trace("198.51.100.010")],
    ["a trailing value", trace(`${US_IP} extra`)],
    ["oversized output", `${trace(US_IP)}${"x".repeat(5000)}`],
  ])("treats %s as no answer", (_case, body) => {
    expect(parseTraceIp(body, PROBE_BUDGETS.maxResponseBytes)).toBeNull();
  });

  it("parses a CRLF trace with one ip line", () => {
    expect(
      parseTraceIp(
        trace(US_IP).replace(/\n/g, "\r\n"),
        PROBE_BUDGETS.maxResponseBytes,
      ),
    ).toBe(US_IP);
  });
});

describe("unavailable streak", () => {
  const unavailable = () =>
    sandbox.commands.run.mockRejectedValueOnce(new Error("curl exit 28"));

  it("fails on the second consecutive window, ignores same-window duplicates and resets after success", async () => {
    unavailable();
    await expect(runEgressHealthCheck("us", at(0))).resolves.toEqual({
      region: "us",
      status: "unavailable",
    });
    // A duplicate run in the same window does not count twice.
    unavailable();
    await expect(runEgressHealthCheck("us", at(0))).resolves.toMatchObject({
      status: "unavailable",
    });

    unavailable();
    expect(
      (await rejection(runEgressHealthCheck("us", at(1)))).reasons,
    ).toEqual(["unavailable"]);

    await expect(runEgressHealthCheck("us", at(2))).resolves.toMatchObject({
      status: "healthy",
    });
    unavailable();
    await expect(runEgressHealthCheck("us", at(3))).resolves.toMatchObject({
      status: "unavailable",
    });
  });

  it("keeps a separate streak per region and counts a malformed answer as unavailable", async () => {
    sandbox.commands.run.mockResolvedValueOnce({ stdout: "not a trace" });
    await expect(runEgressHealthCheck("eu", at(0))).resolves.toMatchObject({
      status: "unavailable",
    });
    unavailable();
    await expect(runEgressHealthCheck("us", at(1))).resolves.toMatchObject({
      status: "unavailable",
    });
    sandbox.commands.run.mockResolvedValueOnce({ stdout: "not a trace" });
    expect(
      (await rejection(runEgressHealthCheck("eu", at(1)))).reasons,
    ).toEqual(["unavailable"]);
  });

  it("counts a failed sandbox create without attempting another create", async () => {
    create.mockRejectedValueOnce(new Error("provider detail"));
    await expect(runEgressHealthCheck("us", at(0))).resolves.toMatchObject({
      status: "unavailable",
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(loggedText()).not.toContain("provider detail");
  });

  it("fails when the streak cannot be recorded", async () => {
    jest.mocked(createRedisClient).mockReturnValue({
      set: jest.fn().mockRejectedValue(new Error("redis down")),
      exists: jest.fn(),
      del: jest.fn(),
    } as never);
    unavailable();

    expect((await rejection(runEgressHealthCheck("us", T0))).reasons).toEqual([
      "state",
    ]);
  });
});

describe("cleanup", () => {
  it("does not finish until sandbox cleanup completes after the probe command fails", async () => {
    let releaseKill!: () => void;
    sandbox.kill.mockReturnValue(
      new Promise((resolve) => {
        releaseKill = () => resolve(true);
      }),
    );
    sandbox.commands.run.mockRejectedValueOnce(new Error("command exit 7"));

    let settled = false;
    const run = runEgressHealthCheck("us", T0).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(sandbox.kill).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);

    releaseKill();
    await expect(run).resolves.toMatchObject({ status: "unavailable" });
  });

  it("fails a run whose IP matched when cleanup fails", async () => {
    sandbox.kill.mockRejectedValue(new Error("kill failed"));

    expect((await rejection(runEgressHealthCheck("us", T0))).reasons).toEqual([
      "cleanup",
    ]);
  });

  it("reports both a wrong IP and failed cleanup", async () => {
    sandbox.commands.run.mockResolvedValue({ stdout: trace(SHARED_IP) });
    sandbox.kill.mockRejectedValue(new Error("kill failed"));

    expect((await rejection(runEgressHealthCheck("us", T0))).reasons).toEqual([
      "wrong_ip",
      "cleanup",
    ]);
  });
});

describe("setup", () => {
  it("does nothing and reads no other configuration until enabled", async () => {
    delete process.env.E2B_EGRESS_MONITOR_ENABLED;
    delete process.env.E2B_MANAGED_EGRESS_US_PROXY;

    await expect(runEgressHealthCheck("us", T0)).resolves.toEqual({
      region: "us",
      status: "disabled",
    });
    expect(createRedisClient).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each<[string, "us" | "eu", () => void]>([
    [
      "a mistyped monitor toggle",
      "us",
      () => {
        process.env.E2B_EGRESS_MONITOR_ENABLED = "TRUE";
      },
    ],
    [
      "pilot-only managed egress",
      "us",
      () => {
        process.env.E2B_MANAGED_EGRESS_ENABLED = "false";
        process.env.E2B_MANAGED_EGRESS_USERS = "egress-health-monitor";
      },
    ],
    [
      "a missing regional proxy",
      "eu",
      () => {
        delete process.env.E2B_MANAGED_EGRESS_EU_PROXY;
      },
    ],
    [
      "an unconfigured EU cluster",
      "eu",
      () => {
        delete process.env.E2B_EU_API_KEY;
      },
    ],
    [
      "a missing US API key",
      "us",
      () => {
        delete process.env.E2B_API_KEY;
      },
    ],
    [
      "a US domain pointing at the EU cluster",
      "us",
      () => {
        process.env.E2B_DOMAIN = "e2b-juliett.dev";
      },
    ],
    [
      "a missing expected IP",
      "eu",
      () => {
        delete process.env.E2B_EGRESS_MONITOR_EU_IP;
      },
    ],
    [
      "a non-canonical expected IP",
      "us",
      () => {
        process.env.E2B_EGRESS_MONITOR_US_IP = "198.51.100.010";
      },
    ],
    [
      "a destinations list without the probe host",
      "us",
      () => {
        process.env.E2B_MANAGED_EGRESS_DESTINATIONS = "api.example.test";
      },
    ],
    [
      "missing Redis",
      "us",
      () => {
        jest.mocked(createRedisClient).mockReturnValue(null);
      },
    ],
  ])(
    "fails %s as configuration before any sandbox call",
    async (_case, region, mutate) => {
      mutate();

      const error = await rejection(runEgressHealthCheck(region, T0));

      expect(error.reasons).toEqual(["configuration"]);
      expect(create).not.toHaveBeenCalled();
      for (const secret of [
        US_PROXY.password,
        EU_PROXY.password,
        "us-api-key",
        "eu-api-key",
      ])
        expect(error.message).not.toContain(secret);
    },
  );

  it("fails inconsistent budgets as configuration before any sandbox call", async () => {
    const error = await rejection(
      runEgressHealthCheck("us", T0, {
        ...PROBE_BUDGETS,
        // A sandbox TTL shorter than its own command would be killed mid-probe.
        sandboxTtlMs: PROBE_BUDGETS.commandMs,
      }),
    );

    expect(error.reasons).toEqual(["configuration"]);
    expect(create).not.toHaveBeenCalled();
  });
});
