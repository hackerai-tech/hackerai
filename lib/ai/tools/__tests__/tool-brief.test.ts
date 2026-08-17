import fs from "fs";
import path from "path";
import { createToolBriefSchema, toolBriefSchema } from "../schemas";

describe("tool brief metadata", () => {
  test("allows omitted briefs for model compatibility", () => {
    expect(toolBriefSchema.safeParse(undefined).success).toBe(true);
    expect(toolBriefSchema.safeParse("Read the generated report").success).toBe(
      true,
    );
  });

  test("uses the passed model to require English briefs for DeepSeek", () => {
    const deepSeekBriefSchema = createToolBriefSchema({
      modelName: "model-deepseek-v4-pro-0813",
    });
    const otherBriefSchema = createToolBriefSchema({
      modelName: "model-grok-4.6",
    });

    expect(deepSeekBriefSchema.description).toContain(
      "Always provide a concise one-sentence English preamble",
    );
    expect(deepSeekBriefSchema.description).toContain(
      "English only, never Chinese or another language",
    );
    expect(otherBriefSchema.description).not.toContain("English only");
    expect(toolBriefSchema.description).not.toContain("English only");
  });

  test("schema catalog brief-bearing tools use the shared optional schema", () => {
    const toolsDir = path.resolve(__dirname, "..");
    const schemaSource = fs.readFileSync(
      path.join(toolsDir, "schemas.ts"),
      "utf8",
    );

    expect(schemaSource).toContain("export const toolBriefSchema");
    expect(
      schemaSource.match(
        /brief:\s*createToolBriefSchema\(\{\s*modelName\s*\}\)/g,
      )?.length ?? 0,
    ).toBeGreaterThanOrEqual(6);
    expect(schemaSource).not.toMatch(
      /brief:\s*z(?:\s*\.\s*string\(\)|\s*\n\s*\.string\(\))/,
    );
  });
});
