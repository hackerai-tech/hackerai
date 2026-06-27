import { describe, expect, it } from "@jest/globals";

import { getResumeSection } from "../resume";

describe("getResumeSection", () => {
  it("tells context-limit resumes not to restart completed work", () => {
    const resumeSection = getResumeSection("context-limit");

    expect(resumeSection).toContain("Do not restart the original task");
    expect(resumeSection).toContain("repeat completed tool work");
    expect(resumeSection).toContain("current sandbox state");
  });
});
