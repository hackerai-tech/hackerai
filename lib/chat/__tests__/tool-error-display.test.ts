import {
  createFindingFailureContent,
  createToolInputErrorContent,
  extractSafeToolValidationIssues,
  getSafeToolErrorText,
  getToolDisplayName,
  isToolInputValidationError,
  SAFE_TOOL_INPUT_ERROR_TEXT,
} from "../tool-error-display";

describe("tool error display", () => {
  it.each([
    "Invalid input for tool shell: Value: {}",
    "Type validation failed: Value: {}",
    "Invalid tool arguments for web_search",
    "Tool input validation error",
  ])("detects framework parameter errors: %s", (errorText) => {
    expect(isToolInputValidationError(errorText)).toBe(true);
  });

  it("does not hide useful runtime failures", () => {
    const runtimeError = "Connection refused by 127.0.0.1:8080";
    expect(isToolInputValidationError(runtimeError)).toBe(false);
    expect(getSafeToolErrorText(runtimeError, "Fallback")).toBe(runtimeError);
  });

  it("never copies raw generated parameters into sidebar content", () => {
    const rawError =
      'Invalid input for tool shell: Value: {"command":"private command"}';
    const content = createToolInputErrorContent({
      toolType: "tool-shell",
      toolCallId: "call-1",
    });

    expect(getSafeToolErrorText(rawError, "Fallback")).toBe(
      SAFE_TOOL_INPUT_ERROR_TEXT,
    );
    expect(content).toMatchObject({
      kind: "tool-error",
      errorKind: "validation",
      toolName: "Terminal",
      action: "Tool input needs attention",
      toolCallId: "call-1",
    });
    expect(JSON.stringify(content)).not.toMatch(/private command|Value:/);
  });

  it("extracts field names and problem categories without copying values", () => {
    const rawError =
      'Invalid input for tool create_vulnerability_report: Type validation failed: Value: {"cve":"private-value","code_locations":[{"file":"private.ts"}]}. Error message: [{"code":"invalid_format","path":["cve"],"message":"private-value is invalid"},{"code":"too_small","path":["code_locations",0,"file"],"message":"private.ts is too short"}]';

    expect(extractSafeToolValidationIssues(rawError)).toEqual([
      { field: "CVE", problem: "Invalid format" },
      {
        field: "Code locations · #1 · File",
        problem: "Missing or too short",
      },
    ]);

    const content = createToolInputErrorContent({
      toolType: "tool-create_vulnerability_report",
      toolCallId: "finding-call",
      errorText: rawError,
    });
    expect(JSON.stringify(content)).not.toMatch(
      /private-value|private\.ts|Value:|message/,
    );
  });

  it("uses friendly names for known and unknown tools", () => {
    expect(getToolDisplayName("tool-create_vulnerability_report")).toBe(
      "Vulnerability report",
    );
    expect(getToolDisplayName("tool-custom_scanner")).toBe("Custom scanner");
  });

  it.each([
    "validation",
    "chat_not_found",
    "general",
    "invalid_result",
  ] as const)("creates safe finding details for %s failures", (reason) => {
    const content = createFindingFailureContent({
      toolCallId: "finding-call",
      reason,
    });
    expect(content.toolName).toBe("Vulnerability report");
    expect(content.title).toBeTruthy();
    expect(content.summary).toBeTruthy();
    expect(content.nextStep).toBeTruthy();
  });
});
