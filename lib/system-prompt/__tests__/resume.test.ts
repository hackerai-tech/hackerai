import { describe, expect, it } from "@jest/globals";

import { getResumeSection } from "../resume";

describe("getResumeSection", () => {
  it("instructs budget-exhausted continuations to resume without repeating work", () => {
    const section = getResumeSection("budget-exhausted");

    expect(section).toContain("user cost-control pause");
    expect(section).toContain("resume the task exactly where you left off");
    expect(section).toContain("without repeating completed work");
  });
});
