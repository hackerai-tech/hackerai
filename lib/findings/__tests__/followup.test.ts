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
  expect(verify).not.toContain(finding.evidence);
  expect(verify).not.toContain(finding.target);
  expect(findingFollowupPrompt(finding, "retest")).toContain(
    "currently authorized target",
  );
});
