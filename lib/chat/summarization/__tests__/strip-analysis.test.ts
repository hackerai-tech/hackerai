import { describe, it, expect } from "@jest/globals";
import { stripAnalysisTags } from "../helpers";

describe("stripAnalysisTags", () => {
  it("strips analysis block and returns only the summary", () => {
    const input =
      "<analysis>Some chain-of-thought reasoning here.</analysis>\nThis is the actual summary.";
    expect(stripAnalysisTags(input)).toBe("This is the actual summary.");
  });

  it("returns text as-is when there are no analysis tags", () => {
    const input = "Plain summary text with no tags.";
    expect(stripAnalysisTags(input)).toBe("Plain summary text with no tags.");
  });

  it("strips all analysis blocks when there are multiple", () => {
    const input =
      "<analysis>First analysis.</analysis>\nSome content.\n<analysis>Second analysis.</analysis>\nFinal summary.";
    expect(stripAnalysisTags(input)).toBe("Some content.\nFinal summary.");
  });

  it("returns empty string when text is empty", () => {
    expect(stripAnalysisTags("")).toBe("");
  });

  it("returns original text trimmed when stripping leaves only whitespace", () => {
    const input = "  <analysis>Only analysis here, nothing else.</analysis>  ";
    expect(stripAnalysisTags(input)).toBe(
      "<analysis>Only analysis here, nothing else.</analysis>",
    );
  });

  it("strips multiline analysis content", () => {
    const input =
      "<analysis>\nLine one of analysis.\nLine two of analysis.\n</analysis>\nThe real summary starts here.";
    expect(stripAnalysisTags(input)).toBe("The real summary starts here.");
  });

  it("strips analysis tag when content immediately follows the closing tag without a space", () => {
    const input = "<analysis>Reasoning.</analysis>Summary immediately after.";
    expect(stripAnalysisTags(input)).toBe("Summary immediately after.");
  });
});
