import fs from "fs";
import path from "path";
import { toolBriefSchema } from "../tool-brief";

describe("tool brief metadata", () => {
  test("allows omitted briefs for model compatibility", () => {
    expect(toolBriefSchema.safeParse(undefined).success).toBe(true);
    expect(toolBriefSchema.safeParse("Read the generated report").success).toBe(
      true,
    );
  });

  test("all brief-bearing tools use the shared optional schema", () => {
    const toolsDir = path.resolve(__dirname, "..");
    const filesWithBrief = [
      "file.ts",
      "get-terminal-files.ts",
      "interact-terminal-session.ts",
      "open-url.ts",
      "run-terminal-cmd.ts",
      "web-search.ts",
    ];

    for (const file of filesWithBrief) {
      const source = fs.readFileSync(path.join(toolsDir, file), "utf8");
      expect(source).toContain("toolBriefSchema");
      expect(source).toMatch(/brief:\s*toolBriefSchema/);
      expect(source).not.toMatch(
        /brief:\s*z(?:\s*\.\s*string\(\)|\s*\n\s*\.string\(\))/,
      );
    }
  });
});
