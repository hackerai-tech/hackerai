import { describe, expect, it, jest, afterEach } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnySandbox } from "@/types";
import {
  evidenceVerificationSchema,
  securityValidationResultSchema,
  securityTaskResultSchema,
  type SubagentStructuredResult,
} from "../contracts";
import {
  evidenceFilePath,
  evidenceWarningText,
  EVIDENCE_STAT_SCRIPT,
  verifyResultEvidence,
  verifyEvidenceReferences,
  EVIDENCE_CHECK_TIMEOUT_MS,
} from "../evidence-references";

const finding = (
  refs: string[] = ["/tmp/control.http", "file:/tmp/exploit.http"],
): SubagentStructuredResult =>
  securityValidationResultSchema.parse({
    verdict: "confirmed",
    confidence: "high",
    summary: "Bounded synthetic finding.",
    reproduction_steps: [
      "Compare the synthetic control and exploit responses.",
    ],
    evidence_refs: refs,
    limitations: [],
    recommended_severity: "medium",
  });
const commandResult = (states: string[]) => ({
  stdout: JSON.stringify(states),
  stderr: "",
  exitCode: 0,
});
function setup(
  result = finding(),
  kind: "e2b" | "miosa" | "local" | "desktop" = "e2b",
) {
  const run = jest
    .fn<(...args: unknown[]) => Promise<ReturnType<typeof commandResult>>>()
    .mockResolvedValue(commandResult(["exists", "exists"]));
  const stat = jest
    .fn<(...args: unknown[]) => Promise<{ kind: string }>>()
    .mockResolvedValue({ kind: "file" });
  const sandbox = {
    sandboxKind: kind === "local" || kind === "desktop" ? "centrifugo" : kind,
    sandboxId: "owned",
    getConnectionId: () => "owned",
    isWindows: () => false,
    supportsNativeFileRelay: () => kind === "desktop",
    files: { stat },
    commands: { run },
  } as unknown as AnySandbox;
  const controller = new AbortController();
  const authorize = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const args = {
    result,
    sandbox,
    expectedSandboxIdentity: `${kind === "local" || kind === "desktop" ? "connection" : kind}:owned`,
    signal: controller.signal,
    authorize,
  };
  return { run, stat, controller, authorize, args };
}
afterEach(() => jest.useRealTimers());

describe("saved evidence verification", () => {
  it.each(["e2b", "miosa", "local", "desktop"] as const)(
    "accepts valid captures in the owned %s sandbox without changing verdict",
    async (kind) => {
      const { args, run, stat } = setup(finding(), kind);
      const output = await verifyResultEvidence(args);
      expect(output).toMatchObject({
        accepted: true,
        result: {
          verdict: "confirmed",
          evidence_refs: args.result.evidence_refs,
          evidence_verification: {
            checked_refs: args.result.evidence_refs,
            unavailable_refs: [],
          },
        },
      });
      expect(kind === "desktop" ? stat : run).toHaveBeenCalledTimes(
        kind === "desktop" ? 2 : 1,
      );
    },
  );
  it("rejects a missing capture and permits a corrected resubmission", async () => {
    const { args, run } = setup();
    run.mockResolvedValueOnce(commandResult(["exists", "missing"]));
    expect(await verifyResultEvidence(args)).toMatchObject({
      accepted: false,
      error: expect.stringContaining("file:/tmp/exploit.http"),
    });
    expect(await verifyResultEvidence(args)).toMatchObject({ accepted: true });
  });
  it.each([
    new Error("disconnected"),
    Object.assign(new Error("service failed"), { status: 503 }),
  ])("preserves outage results with unverified references", async (error) => {
    const { args, run } = setup();
    run.mockRejectedValue(error);
    const output = await verifyResultEvidence(args);
    if (!output.accepted) throw new Error("Expected preserved result");
    expect(output.result).toMatchObject({
      verdict: "confirmed",
      evidence_refs: [],
      evidence_verification: {
        checked_refs: [],
        unavailable_refs: args.result.evidence_refs,
        warning: expect.any(String),
      },
    });
    expect(evidenceWarningText(output.result)).toContain("/tmp/exploit.http");
    expect(evidenceWarningText(output.result)).toContain(
      "not attached as verified evidence",
    );
    run.mockResolvedValue(commandResult(["exists", "exists"]));
    expect(await verifyResultEvidence(args)).toMatchObject({
      accepted: true,
      result: { evidence_verification: { unavailable_refs: [] } },
    });
  });
  it("finishes an unresponsive check in five seconds with no retry", async () => {
    jest.useFakeTimers();
    const { args, run } = setup();
    run.mockImplementation(() => new Promise(() => {}));
    const pending = verifyResultEvidence(args);
    await jest.advanceTimersByTimeAsync(EVIDENCE_CHECK_TIMEOUT_MS);
    expect(await pending).toMatchObject({
      accepted: true,
      result: {
        evidence_refs: [],
        evidence_verification: { unavailable_refs: args.result.evidence_refs },
      },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });
  it("does not hide a forbidden desktop result when another stat times out", async () => {
    jest.useFakeTimers();
    const { args, stat } = setup(finding(), "desktop");
    stat
      .mockRejectedValueOnce(
        Object.assign(new Error("Permission denied: private data"), {
          code: "EACCES",
        }),
      )
      .mockImplementationOnce(() => new Promise(() => {}));
    const pending = verifyResultEvidence(args);
    await jest.advanceTimersByTimeAsync(EVIDENCE_CHECK_TIMEOUT_MS);
    expect(await pending).toEqual({
      accepted: false,
      error: expect.stringContaining("Evidence access was denied"),
    });
  });
  it.each([401, 403])(
    "does not attach forbidden service responses (%s) or leak diagnostics",
    async (status) => {
      const { args, run } = setup();
      run.mockRejectedValue(
        Object.assign(new Error("private-provider-payload"), { status }),
      );
      const output = await verifyResultEvidence(args);
      expect(output).toMatchObject({ accepted: false });
      expect(JSON.stringify(output)).not.toContain("private-provider-payload");
    },
  );
  it("never reads another user's sandbox or bypasses revoked authorization", async () => {
    const { args, run, authorize } = setup();
    await expect(
      verifyResultEvidence({
        ...args,
        expectedSandboxIdentity: "e2b:other-user",
      }),
    ).rejects.toThrow("sandbox changed");
    authorize.mockRejectedValueOnce(new Error("Ownership revoked"));
    await expect(verifyResultEvidence(args)).rejects.toThrow(
      "Ownership revoked",
    );
    expect(run).not.toHaveBeenCalled();
    authorize
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Ownership revoked during check"));
    await expect(verifyResultEvidence(args)).rejects.toThrow(
      "Ownership revoked during check",
    );
  });
  it("keeps static-only findings and opaque evidence without inventing an HTTP requirement", async () => {
    const { args, run } = setup(
      finding(["terminal:attempt-1", "artifact:proof", "https://example.test"]),
    );
    expect(await verifyResultEvidence(args)).toEqual({
      accepted: true,
      result: args.result,
    });
    expect(run).not.toHaveBeenCalled();
    run.mockResolvedValue(commandResult(["exists"]));
    expect(
      await verifyResultEvidence({
        ...args,
        result: finding(["file:src/auth.ts:42"]),
      }),
    ).toMatchObject({ accepted: true, result: { verdict: "confirmed" } });
  });
  it("deduplicates storage reads across mixed top-level and coverage refs and keeps outage coverage", async () => {
    const result = securityTaskResultSchema.parse({
      task_status: "completed",
      summary: "Synthetic task",
      evidence_refs: [
        "/tmp/control.http",
        "file:/tmp/control.http",
        "/tmp/control.http",
        "terminal:1",
      ],
      artifacts: [],
      limitations: [],
      next_steps: [],
      coverage: [
        {
          surface: "example.test",
          risk_area: "access",
          outcome: "Observed difference",
          evidence_refs: ["/tmp/exploit.http"],
        },
      ],
    });
    const { args, run } = setup(result);
    run.mockResolvedValue(commandResult(["exists", "unavailable"]));
    const output = await verifyResultEvidence(args);
    if (!output.accepted) throw new Error("Expected preserved report");
    expect(output.result.evidence_refs).toEqual([
      "/tmp/control.http",
      "file:/tmp/control.http",
      "terminal:1",
    ]);
    expect(run.mock.calls[0][1]).toMatchObject({
      envVars: {
        HACKERAI_EVIDENCE_PATHS: JSON.stringify([
          "/tmp/control.http",
          "/tmp/exploit.http",
        ]),
      },
      timeoutMs: 5000,
    });
    expect(output.result).toMatchObject({
      coverage: [{ outcome: "Observed difference", evidence_refs: [] }],
      evidence_verification: { unavailable_refs: ["/tmp/exploit.http"] },
    });
  });
  it("honors cancellation before reads and while verification is pending", async () => {
    const first = setup();
    first.controller.abort();
    await expect(verifyResultEvidence(first.args)).rejects.toThrow();
    expect(first.run).not.toHaveBeenCalled();
    const second = setup();
    second.run.mockImplementation(() => new Promise(() => {}));
    const pending = verifyResultEvidence(second.args);
    await Promise.resolve();
    await Promise.resolve();
    second.controller.abort();
    await expect(pending).rejects.toThrow();
  });
  it("treats malformed or failed command output as unavailable, never absent", async () => {
    const { args, run } = setup();
    run.mockResolvedValue({ stdout: '["missing"]', stderr: "", exitCode: 0 });
    expect(await verifyResultEvidence(args)).toMatchObject({
      accepted: true,
      result: { evidence_refs: [] },
    });
  });
  it("bounds raw-reference callers before issuing a sandbox read", async () => {
    const { args, run } = setup();
    expect(
      await verifyEvidenceReferences({
        ...args,
        refs: Array.from({ length: 41 }, (_, i) => `/tmp/${i}`),
      }),
    ).toMatchObject({ accepted: false });
    expect(
      await verifyEvidenceReferences({ ...args, refs: ["/".repeat(501)] }),
    ).toMatchObject({ accepted: false });
    expect(run).not.toHaveBeenCalled();
  });
  it("does not let the model supply verified metadata", () => {
    expect(
      securityValidationResultSchema.parse({
        ...finding(),
        evidence_verification: { checked_refs: ["fake"] },
      }),
    ).not.toHaveProperty("evidence_verification");
  });
  it("rejects blank saved evidence metadata while allowing empty lists", () => {
    const empty = { checked_refs: [], unavailable_refs: [] };
    expect(evidenceVerificationSchema.safeParse(empty).success).toBe(true);
    for (const metadata of [
      { ...empty, checked_refs: [" "] },
      { ...empty, unavailable_refs: ["\t"] },
      { ...empty, warning: " " },
    ]) {
      expect(evidenceVerificationSchema.safeParse(metadata).success).toBe(
        false,
      );
    }
  });
  it("checks real files deterministically without reading payloads or shell-interpolating paths", async () => {
    const dir = mkdtempSync(join(tmpdir(), "evidence-check-"));
    try {
      const capture = join(dir, "capture'$(touch SHOULD_NOT_EXIST).http");
      writeFileSync(capture, "private synthetic response");
      mkdirSync(join(dir, "directory"));
      const result = execFileSync("python3", ["-c", EVIDENCE_STAT_SCRIPT], {
        env: {
          ...process.env,
          HACKERAI_EVIDENCE_PATHS: JSON.stringify([
            capture,
            join(dir, "absent"),
            join(dir, "directory"),
          ]),
        },
        encoding: "utf8",
        timeout: 5000,
      });
      expect(JSON.parse(result)).toEqual(["exists", "missing", "missing"]);
      expect(result).not.toContain("private synthetic response");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it.each([
    ["file:src/auth.ts:42", "src/auth.ts"],
    ["file:/tmp/capture.http", "/tmp/capture.http"],
    ["C:\\captures\\response.txt", "C:\\captures\\response.txt"],
    ["/tmp/proof#L4-L8", "/tmp/proof#L4-L8"],
    ["file:/tmp/proof#L4-L8", "/tmp/proof"],
    ["/tmp/proof:200", "/tmp/proof:200"],
    ["https://example.test", undefined],
    ["//other-host/private", undefined],
    ["file://other-host/private", undefined],
    ["terminal:attempt", undefined],
  ])("parses %s as %s", (ref, path) =>
    expect(evidenceFilePath(ref!)).toBe(path),
  );
});
