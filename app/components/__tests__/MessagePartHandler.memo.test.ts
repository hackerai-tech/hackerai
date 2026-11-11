import { areMessagePartHandlerPropsEqual } from "../MessagePartHandler";

const props = (part: Record<string, unknown>) =>
  ({
    message: { id: "message-1", role: "assistant", parts: [part] },
    part,
    partIndex: 0,
    status: "ready",
  }) as any;

describe("MessagePartHandler memoization", () => {
  it("re-renders when shared finding metadata changes", () => {
    const original = props({
      type: "data-shared-finding",
      data: {
        title: "Confirmed IDOR",
        target: "app.example.test",
        severity: "high",
        cvss_score: 7.1,
      },
    });
    const updated = props({
      type: "data-shared-finding",
      data: {
        title: "Confirmed IDOR",
        target: "api.example.test",
        severity: "critical",
        cvss_score: 9.1,
      },
    });

    expect(areMessagePartHandlerPropsEqual(original, updated)).toBe(false);
  });

  it("never treats different part types as equal", () => {
    const sharedFinding = props({
      type: "data-shared-finding",
      data: { title: "Confirmed IDOR" },
    });
    const otherData = props({
      type: "data-notification",
      data: { title: "Confirmed IDOR" },
    });

    expect(areMessagePartHandlerPropsEqual(sharedFinding, otherData)).toBe(
      false,
    );
  });

  it("keeps equivalent shared finding data memoized", () => {
    const first = props({
      type: "data-shared-finding",
      data: { title: "Confirmed IDOR", cvss_score: 7.1 },
    });
    const second = props({
      type: "data-shared-finding",
      data: { title: "Confirmed IDOR", cvss_score: 7.1 },
    });

    expect(areMessagePartHandlerPropsEqual(first, second)).toBe(true);
  });

  it("re-renders when a tool error changes classification", () => {
    const runtimeFailure = props({
      type: "tool-shell",
      state: "output-error",
      toolCallId: "call-1",
      input: { command: "npm test" },
      errorText: "Sandbox unavailable",
    });
    const validationFailure = props({
      type: "tool-shell",
      state: "output-error",
      toolCallId: "call-1",
      input: { command: "npm test" },
      errorText: "Invalid input for tool shell: Type validation failed",
    });

    expect(
      areMessagePartHandlerPropsEqual(runtimeFailure, validationFailure),
    ).toBe(false);
  });

  it("re-renders when a dynamic tool name changes", () => {
    const firstTool = props({
      type: "dynamic-tool",
      toolName: "first_tool",
      state: "output-error",
      toolCallId: "call-1",
      errorText: "Invalid tool arguments",
    });
    const secondTool = props({
      type: "dynamic-tool",
      toolName: "second_tool",
      state: "output-error",
      toolCallId: "call-1",
      errorText: "Invalid tool arguments",
    });

    expect(areMessagePartHandlerPropsEqual(firstTool, secondTool)).toBe(false);
  });

  describe("text with sandbox download links", () => {
    const linkText = {
      type: "text",
      text: "Saved [report.txt](sandbox:/home/user/report.txt).",
    };
    const plainText = { type: "text", text: "Saved the report." };
    const delivery = {
      type: "tool-get_terminal_files",
      state: "output-available",
      output: {
        deliveryReceipts: [
          {
            fileId: "file-1",
            sourcePath: "/home/user/report.txt",
            storageStatus: "stored",
          },
        ],
      },
    };
    const textProps = (
      part: Record<string, unknown>,
      parts: Record<string, unknown>[],
      sharedFileDetails?: unknown[],
    ) => ({
      ...props(part),
      message: { id: "message-1", role: "assistant", parts },
      sharedFileDetails,
    });

    it("re-renders unchanged link text when file metadata arrives", () => {
      const before = textProps(linkText, [delivery, linkText]);
      const after = textProps(
        linkText,
        [delivery, linkText],
        [{ fileId: "file-1", name: "report.txt" }],
      );

      expect(areMessagePartHandlerPropsEqual(before, after)).toBe(false);
    });

    it("re-renders unchanged link text when a delivery receipt arrives", () => {
      const fileDetails = [{ fileId: "file-1", name: "report.txt" }];
      const pending = {
        ...delivery,
        state: "input-available",
        output: undefined,
      };
      const before = textProps(linkText, [pending, linkText], fileDetails);
      const after = textProps(linkText, [delivery, linkText], fileDetails);

      expect(areMessagePartHandlerPropsEqual(before, after)).toBe(false);
    });

    it("keeps ordinary streamed text memoized when file metadata changes", () => {
      const before = textProps(plainText, [delivery, plainText]);
      const after = textProps(
        plainText,
        [delivery, plainText],
        [{ fileId: "file-1", name: "report.txt" }],
      );

      expect(areMessagePartHandlerPropsEqual(before, after)).toBe(true);
    });

    it("keeps link text memoized when unrelated message parts change", () => {
      const fileDetails = [{ fileId: "file-1", name: "report.txt" }];
      const before = textProps(linkText, [delivery, linkText], fileDetails);
      const after = textProps(
        linkText,
        [delivery, linkText, { type: "reasoning", text: "Done" }],
        fileDetails,
      );

      expect(areMessagePartHandlerPropsEqual(before, after)).toBe(true);
    });
  });
});
