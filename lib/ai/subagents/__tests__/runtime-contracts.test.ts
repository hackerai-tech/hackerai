import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "@jest/globals";

const root = process.cwd();
const read = (path: string) => readFileSync(join(root, path), "utf8");

describe("security validation subagent runtime contracts", () => {
  it("uses a durable bounded child task with its own stream and no recursion", () => {
    const source = read("trigger/subagent.ts");
    expect(source).toContain('id: "hackerai-subagent"');
    expect(source).toContain("getSubagentProfileDefinition");
    expect(source).toContain("agentUiStream.pipe");
    expect(source).toContain("SUBAGENT_MAX_ACTIVE_SECONDS");
    expect(source).toContain("SUBAGENT_MAX_STEPS");
    expect(source).toContain("row.cost_limit_dollars");
    expect(source).toContain("retry: { maxAttempts: 1 }");
    expect(source).not.toMatch(/allowedToolNames:[\s\S]{0,500}"delegate_task"/);
  });

  it("waits idempotently and scopes the browser token to the owned child run", () => {
    const delegate = read("lib/ai/tools/delegate-task.ts");
    const tokenRoute = read("app/api/subagents/[subagentId]/token/route.ts");
    expect(delegate).toContain("triggerAndWait");
    expect(delegate).toContain('scope: "global"');
    expect(delegate).toContain("acknowledgeSubagentResult");
    expect(delegate.indexOf("SUBAGENT_TERMINAL_STATUSES.has")).toBeLessThan(
      delegate.indexOf("triggerAndWait"),
    );
    expect(tokenRoute).toContain("getOwnedSubagent");
    expect(tokenRoute).toContain("runs: [child.trigger_run_id]");
    expect(tokenRoute).toContain('expirationTime: "10m"');
  });

  it("propagates parent cancellation and refuses a canceled queued child", () => {
    const parent = read("trigger/agent-long.ts");
    const child = read("trigger/subagent.ts");
    expect(parent).toContain("listActiveSubagentsForParent");
    expect(parent).toContain("cancelAgentTriggerRun(child.trigger_run_id)");
    expect(parent).toContain("cancelSubagentsForParent");
    expect(child.indexOf('row.status === "canceled"')).toBeLessThan(
      child.indexOf("await attachSubagentTriggerRun"),
    );
  });

  it("keeps report promotion behind the independent validation gate", () => {
    const report = read("convex/vulnerabilityReports.ts");
    expect(report).toContain('validation.status !== "completed"');
    expect(report).toContain('validation.verdict !== "confirmed"');
    expect(report).toContain("acknowledged_by_parent_run_id");
    expect(report).toContain('reason: "evidence_mismatch"');
    expect(report).toContain('reason: "reproduction_mismatch"');
    expect(report).toContain('reason: "severity_exceeds_validation"');
  });
});
