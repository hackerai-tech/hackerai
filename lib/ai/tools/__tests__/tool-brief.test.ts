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

  test("schema catalog brief-bearing tools use the shared optional schema", () => {
    const toolsDir = path.resolve(__dirname, "..");
    const schemaSource = fs.readFileSync(
      path.join(toolsDir, "schemas.ts"),
      "utf8",
    );

    expect(schemaSource).toContain("export const toolBriefSchema");
    expect(
      schemaSource.match(/brief:\s*toolBriefSchema/g)?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
    expect(schemaSource).not.toMatch(
      /brief:\s*z(?:\s*\.\s*string\(\)|\s*\n\s*\.string\(\))/,
    );
  });
});
