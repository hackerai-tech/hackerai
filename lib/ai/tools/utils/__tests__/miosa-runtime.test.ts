import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { miosaRuntimeCommand, miosaRuntimeForTemplate } from "../miosa-runtime";

describe("MIOSA runtime selection and command quoting", () => {
  it("selects native execution only for the acquired native tools template", () => {
    expect(miosaRuntimeForTemplate("hackerai-tools")).toBe("native");
    expect(miosaRuntimeForTemplate("miosa-sandbox-docker")).toBe("docker");
    expect(miosaRuntimeForTemplate(undefined)).toBe("docker");
  });

  it("preserves the legacy container command", () => {
    expect(miosaRuntimeCommand("docker", "echo ok")).toBe(
      "docker exec --workdir '/home/user' 'hackerai-agent' bash -lc 'echo ok'",
    );
  });

  it("executes native commands in the requested directory with literal environment values", async () => {
    const value = "quote ' and 雪; $(printf injected)";
    const command = miosaRuntimeCommand(
      "native",
      "printf '%s\\n' \"$TEST_VALUE\"; pwd",
      {
        cwd: process.cwd(),
        envVars: { TEST_VALUE: "old" },
        envs: { TEST_VALUE: value },
      },
    );
    expect(command).not.toContain("docker exec");
    expect(command).toContain("HOME=/home/user");
    const result = await promisify(execFile)("bash", ["-c", command]);
    expect(result.stdout).toBe(`${value}\n${process.cwd()}\n`);
  });

  it("uses the same native directory and environment for PTYs", () => {
    expect(miosaRuntimeCommand("native", "exec bash", {}, true)).toBe(
      miosaRuntimeCommand("native", "exec bash"),
    );
  });

  it("does not execute any part of a command when its working directory is missing", async () => {
    const command = miosaRuntimeCommand("native", "true; printf unexpected", {
      cwd: "/dev/null/not-a-directory",
    });
    await expect(
      promisify(execFile)("bash", ["-c", command]),
    ).rejects.toMatchObject({
      code: 1,
      stdout: "",
    });
  });

  it("does not background the directory guard along with a detached command", async () => {
    const command = miosaRuntimeCommand(
      "native",
      "sleep 3 >/dev/null 2>&1 </dev/null & printf '%s' \"$!\"",
      { cwd: process.cwd() },
    );
    const started = performance.now();
    const result = await promisify(execFile)("bash", ["-c", command]);
    const elapsed = performance.now() - started;
    const pid = Number(result.stdout);
    expect(pid).toBeGreaterThan(1);
    // This exact PID belongs to the disposable child started by this test.
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // If the wrapper regresses, the child has already exited after 3 seconds.
    }
    expect(elapsed).toBeLessThan(1500);
  });
});
