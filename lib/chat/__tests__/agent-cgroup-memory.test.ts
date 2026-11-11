import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from "@jest/globals";
import { readAgentCgroupMemory } from "../agent-cgroup-memory";

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const ROOT = "/sys/fs/cgroup";

describe("self cgroup memory", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "linux" });
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", platform);
  });

  function fixture(overrides: Record<string, string | undefined> = {}) {
    const files: Record<string, string | undefined> = {
      "/proc/self/cgroup": "0::/\n",
      [ROOT + "/cgroup.procs"]: `${process.pid}\n`,
      [ROOT + "/memory.current"]: "734003200\n",
      [ROOT + "/memory.peak"]: "1006632960\n",
      [ROOT + "/memory.max"]: "1073741824\n",
      [ROOT + "/memory.events"]:
        "low 0\nhigh 2\nmax 3\noom 1\noom_kill 0\nprivate-canary 991\n",
      ...overrides,
    };
    return jest.fn((file: string) => files[file]);
  }

  it("distinguishes kernel group usage/peak/limit and lifetime pressure from process RSS", () => {
    const fields = readAgentCgroupMemory(fixture());
    expect(fields).toEqual({
      cgroup_memory_version: 1,
      cgroup_memory_status: "available",
      cgroup_memory_scope: "self_membership",
      cgroup_memory_current_bytes: 734003200,
      cgroup_memory_peak_bytes: 1006632960,
      cgroup_memory_limit_kind: "bounded",
      cgroup_memory_limit_bytes: 1073741824,
      cgroup_lifetime_high_events: 2,
      cgroup_lifetime_max_events: 3,
      cgroup_lifetime_oom_events: 1,
      cgroup_lifetime_oom_kill_events: 0,
    });
    expect(JSON.stringify(fields)).not.toContain("private-canary");
    expect(JSON.stringify(fields)).not.toContain(ROOT);
  });

  it("rejects an ancestor root and reads only the verified nested self group", () => {
    const leaf = ROOT + "/private-group";
    const read = fixture({
      "/proc/self/cgroup": "0::/private-group\n",
      [ROOT + "/cgroup.procs"]: "999999999\n",
      [ROOT + "/memory.current"]: "999999999\n",
      [leaf + "/cgroup.procs"]: `${process.pid}\n`,
      [leaf + "/memory.current"]: "512\n",
      [leaf + "/memory.max"]: "max\n",
    });
    const fields = readAgentCgroupMemory(read);
    expect(fields).toMatchObject({
      cgroup_memory_current_bytes: 512,
      cgroup_memory_limit_kind: "unlimited",
    });
    expect(fields).not.toHaveProperty("cgroup_memory_limit_bytes");
    expect(fields).not.toHaveProperty("cgroup_memory_peak_bytes");
    expect(read).not.toHaveBeenCalledWith(ROOT + "/memory.current");
    expect(JSON.stringify(fields)).not.toContain("private-group");
  });

  it("keeps an unavailable self group separate from an observed zero counter", () => {
    const read = fixture({ [ROOT + "/cgroup.procs"]: "999999999\n" });
    expect(readAgentCgroupMemory(read)).toEqual({
      cgroup_memory_version: 1,
      cgroup_memory_status: "self_unverified",
    });
    expect(read).not.toHaveBeenCalledWith(ROOT + "/memory.current");
  });

  it.each(["-1", "1.5", "9007199254740992", "private-error", ""])(
    "omits unusable required readings rather than inventing usage: %s",
    (current) => {
      expect(
        readAgentCgroupMemory(fixture({ [ROOT + "/memory.current"]: current })),
      ).toEqual({
        cgroup_memory_version: 1,
        cgroup_memory_status: "unavailable",
      });
    },
  );

  it.each(["0::/../private\n", "0::/private path\n", "1:memory:/\n"])(
    "never derives a kernel path from an unusable membership",
    (membership) => {
      const read = fixture({ "/proc/self/cgroup": membership });
      expect(readAgentCgroupMemory(read).cgroup_memory_status).toBe(
        "unavailable",
      );
      expect(read).toHaveBeenCalledTimes(1);
    },
  );

  it("bounds file contents and isolates read failures", () => {
    expect(
      readAgentCgroupMemory(fixture({ "/proc/self/cgroup": "x".repeat(8193) }))
        .cgroup_memory_status,
    ).toBe("unavailable");
    expect(
      readAgentCgroupMemory(() => {
        throw new Error("private-path-and-error");
      }),
    ).toEqual({
      cgroup_memory_version: 1,
      cgroup_memory_status: "unavailable",
    });
  });

  it("does not read Linux kernel paths on other platforms", () => {
    Object.defineProperty(process, "platform", {
      ...platform,
      value: "darwin",
    });
    const read = fixture();
    expect(readAgentCgroupMemory(read)).toEqual({});
    expect(read).not.toHaveBeenCalled();
  });
});
