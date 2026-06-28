import { describe, expect, it } from "@jest/globals";

import { getResumeSection } from "../resume";

describe("getResumeSection", () => {
  it("tells context-limit resumes not to restart completed work", () => {
    const resumeSection = getResumeSection("context-limit");

    expect(resumeSection).toContain("Do not restart the original task");
    expect(resumeSection).toContain("repeat completed tool work");
    expect(resumeSection).toContain("current sandbox state");
  });

  it("instructs budget-exhausted continuations to resume without repeating work", () => {
    const section = getResumeSection("budget-exhausted");

    expect(section).toContain("user cost-control pause");
    expect(section).toContain("resume the task exactly where you left off");
    expect(section).toContain("without repeating completed work");
  });
});
