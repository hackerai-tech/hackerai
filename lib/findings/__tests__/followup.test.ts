import { findingFollowupPrompt } from "../followup";
import type { FindingDetailRecord } from "@/types/finding";

it("hands off an exact saved record without treating report content as authorization", () => {
  const finding = {
    finding_id: 'f"1',
    updated_at: 123,
    target: "https://private.example.test",
    evidence: "sensitive capture",
  } as FindingDetailRecord;
  const verify = findingFollowupPrompt(finding, "verify");
  expect(verify).toContain('finding_id "f\\"1"');
  expect(verify).toContain("123");
  expect(verify).toContain("strongest alternative explanation");
  expect(verify).toContain("current user-authorized");
  expect(verify).toContain("top-level reason");
  expect(verify).toContain("together inside changes");
  expect(verify).not.toContain(finding.evidence);
  expect(verify).not.toContain(finding.target);
  expect(findingFollowupPrompt(finding, "retest")).toContain(
    "currently authorized target",
  );
});

it("requires a recorded retest to start before testing and complete honestly", () => {
  const finding = { finding_id: "f1", updated_at: 7 } as FindingDetailRecord;
  const recorded = findingFollowupPrompt(finding, "retest", {
    recordRetest: true,
  });
  expect(recorded.indexOf("start_finding_retest")).toBeLessThan(
    recorded.indexOf("complete_finding_retest"),
  );
  expect(recorded).toContain("Before sending any test traffic");
  expect(recorded).toContain("expired or wrong access");
  expect(recorded).toContain("never evidence of a fix");
  expect(recorded).toContain("still complete the retest as inconclusive");
  expect(recorded).toContain("Do not update, downgrade or close the report");
  // Without recorded history the existing report-update guidance is unchanged
  // and no unavailable tool is named.
  const plain = findingFollowupPrompt(finding, "retest");
  expect(plain).not.toContain("start_finding_retest");
  expect(plain).toContain("update_vulnerability_report");
  expect(
    findingFollowupPrompt(finding, "verify", { recordRetest: true }),
  ).not.toContain("start_finding_retest");
});

it("asks a hunt to start first, save candidates one by one and never touch the report", () => {
  const finding = {
    finding_id: "f1",
    updated_at: 7,
    target: "https://private.example.test",
    technical_analysis: "private analysis text",
  } as FindingDetailRecord;
  const hunt = findingFollowupPrompt(finding, "hunt");
  expect(hunt).toContain('finding_id "f1"');
  expect(hunt).toContain("current user-authorized");
  const order = [
    "get_report",
    "start_finding_hunt",
    "record_finding_hunt_candidate",
    "complete_finding_hunt",
  ].map((name) => hunt.indexOf(name));
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(hunt).toContain("Before any investigative traffic");
  expect(hunt).toContain("source-only suspicion");
  expect(hunt).toContain(
    "evidence_basis (runtime_check or source_review_only)",
  );
  expect(hunt).toContain(
    "A runtime ruled_out needs a successful same-surface authorized control (authorized_control_succeeded: true)",
  );
  expect(hunt).toContain("blocked access, so inconclusive");
  expect(hunt).toContain("even if you stop early");
  expect(hunt).toContain("do not create reports");
  expect(hunt).toContain("do not start another hunt");
  // The prompt references the saved report; it never copies its content.
  expect(hunt).not.toContain(finding.target);
  expect(hunt).not.toContain("private analysis text");
  expect(hunt).not.toContain("update_vulnerability_report");
});
