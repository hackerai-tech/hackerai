import { describe, expect, it } from "@jest/globals";

import type { AgentToolApprovalOperation } from "@/types";
import {
  deriveAgentApprovalTargetGrant,
  deriveApprovedAgentTargetGrant,
  matchesAgentApprovalTargetGrant,
} from "../agent-approval-grants";

const request = (
  operation: AgentToolApprovalOperation,
  target: string,
  prefixRule?: string[],
) => ({
  operation,
  target,
  ...(prefixRule ? { prefixRule } : {}),
});

describe("agent approval grants", () => {
  it("matches an exact static argv, not another command or executable", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("terminal_execute", "npm test"),
    );

    expect(grant).toMatchObject({
      kind: "terminal_command",
      executable: "npm",
      argv: ["npm", "test"],
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "npm test"),
          grant,
        ),
    ).toBe(true);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "npm publish"),
          grant,
        ),
    ).toBe(false);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "npmx run lint"),
          grant,
        ),
    ).toBe(false);
  });

  it("matches a validated argv prefix across commands in the conversation", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("terminal_execute", "ping -c 4 hackerone.com", [
        "ping",
        "-c",
        "4",
      ]),
    );

    expect(grant).toMatchObject({
      kind: "terminal_command",
      executable: "ping",
      argv: ["ping", "-c", "4"],
      targetPrefix: '["ping","-c","4"]',
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "ping -c 4 example.com"),
          grant,
        ),
    ).toBe(true);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "ping -f example.com"),
          grant,
        ),
    ).toBe(false);
  });

  it.each([
    ["empty", []],
    ["not a command prefix", ["ping", "example.com"]],
    ["different executable", ["curl"]],
    ["longer than the command", ["ping", "-c", "4", "example.com", "extra"]],
  ])("rejects a %s model-proposed prefix rule", (_description, prefixRule) => {
    expect(
      deriveAgentApprovalTargetGrant(
        request(
          "terminal_execute",
          "ping -c 4 example.com",
          prefixRule as string[],
        ),
      ),
    ).toBeNull();
  });

  it("parses a quoted executable as the same static token", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("terminal_execute", "'npm' test"),
    );

    expect(grant).toMatchObject({
      kind: "terminal_command",
      executable: "npm",
      argv: ["npm", "test"],
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", '"npm" test'),
          grant,
        ),
    ).toBe(true);
    expect(
      deriveAgentApprovalTargetGrant(
        request("terminal_execute", 'npm test "literal | value"'),
      ),
    ).toMatchObject({ executable: "npm" });
  });

  it.each([
    ["and chain", "npm test && npm publish"],
    ["or chain", "npm test || npm publish"],
    ["semicolon chain", "npm test; npm publish"],
    ["pipeline", "npm test | cat"],
    ["background operator", "npm test &"],
    ["output redirection", "npm test > output.txt"],
    ["input redirection", "npm test < input.txt"],
    ["descriptor redirection", "npm test 2>&1"],
    ["command substitution", "npm $(cat script-name)"],
    ["double-quoted substitution", 'npm "$(cat script-name)"'],
    ["backticks", "npm `cat script-name`"],
    ["dynamic executable", "$RUNNER test"],
    ["environment assignment", "NODE_ENV=test npm test"],
    ["glob expansion", "npm test *.spec.ts"],
    ["newline", "npm test\nnpm publish"],
  ])("rejects a command containing %s", (_description, target) => {
    const safeGrant = deriveAgentApprovalTargetGrant(
      request("terminal_execute", "npm test"),
    );

    expect(
      deriveAgentApprovalTargetGrant(request("terminal_execute", target)),
    ).toBeNull();
    expect(
      safeGrant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", target),
          safeGrant,
        ),
    ).toBe(false);
  });

  it.each([
    ["shell", "bash -c 'npm test && npm publish'"],
    ["absolute shell", "/bin/bash -lc 'npm test'"],
    ["Windows shell", String.raw`"C:\Windows\System32\cmd.exe" /c dir`],
    ["evaluator", "eval 'npm test'"],
    ["environment dispatcher", "env npm test"],
    ["privilege dispatcher", "sudo npm test"],
  ])("rejects a reusable %s wrapper", (_description, target) => {
    expect(
      deriveAgentApprovalTargetGrant(request("terminal_execute", target)),
    ).toBeNull();
  });

  it("does not confuse a wrapper name with a sibling executable", () => {
    expect(
      deriveAgentApprovalTargetGrant(
        request("terminal_execute", "bashful test"),
      ),
    ).toMatchObject({
      kind: "terminal_command",
      executable: "bashful",
      argv: ["bashful", "test"],
    });
  });

  it.each(["'npm test", '"npm test', "npm test 'unfinished", "npm test \\"])(
    "rejects malformed quoting in %s",
    (target) => {
      expect(
        deriveAgentApprovalTargetGrant(request("terminal_execute", target)),
      ).toBeNull();
    },
  );

  it("normalizes POSIX paths while keeping sibling and traversal targets separate", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("file_write", "/workspace/reports/report.txt"),
    );

    expect(grant).toMatchObject({
      kind: "file_change",
      path: "/workspace/reports/report.txt",
      pathFlavor: "posix",
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("file_edit", "/workspace/reports/drafts/.././report.txt"),
          grant,
        ),
    ).toBe(true);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("file_append", "/workspace/reports/report.txt.bak"),
          grant,
        ),
    ).toBe(false);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("file_edit", "/workspace/reports/../report.txt"),
          grant,
        ),
    ).toBe(false);
  });

  it("rejects surrounding path whitespace while preserving internal spaces", () => {
    expect(
      deriveAgentApprovalTargetGrant(
        request("file_write", " /workspace/report.txt"),
      ),
    ).toBeNull();
    expect(
      deriveAgentApprovalTargetGrant(
        request("file_write", "/workspace/report.txt "),
      ),
    ).toBeNull();
    expect(
      deriveAgentApprovalTargetGrant(
        request("file_write", "/workspace/project files/report.txt"),
      ),
    ).toMatchObject({
      kind: "file_change",
      path: "/workspace/project files/report.txt",
    });
  });

  it("normalizes Windows paths while keeping sibling and traversal targets separate", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("file_write", String.raw`C:\workspace\reports\report.txt`),
    );

    expect(grant).toMatchObject({
      kind: "file_change",
      path: "C:/workspace/reports/report.txt",
      pathFlavor: "windows",
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request(
            "file_edit",
            String.raw`c:\workspace\reports\drafts\..\report.txt`,
          ),
          grant,
        ),
    ).toBe(true);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("file_append", "C:/workspace/reports/report.txt.bak"),
          grant,
        ),
    ).toBe(false);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("file_edit", String.raw`C:\workspace\reports\..\report.txt`),
          grant,
        ),
    ).toBe(false);
  });

  it("keeps terminal interaction grants within one PTY session and action", () => {
    const grant = deriveAgentApprovalTargetGrant(
      request("terminal_interact", "send to a1b2c3d4: yes\n"),
    );

    expect(grant).toMatchObject({
      kind: "terminal_interaction",
      action: "send",
      sessionId: "a1b2c3d4",
      targetPrefix: "send:a1b2c3d4",
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_interact", "send to a1b2c3d4: no\n"),
          grant,
        ),
    ).toBe(true);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_interact", "send to deadbeef: no\n"),
          grant,
        ),
    ).toBe(false);
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_interact", "kill a1b2c3d4"),
          grant,
        ),
    ).toBe(false);
  });

  it("derives the approved scope from the pending request, not tampered client fields", () => {
    const grant = deriveApprovedAgentTargetGrant(
      request("terminal_execute", "npm test -- --runInBand", ["npm", "test"]),
      {
        grant: "target_prefix",
        targetKind: "file_change",
        targetPrefix: "n",
      },
    );

    expect(grant).toMatchObject({
      kind: "terminal_command",
      executable: "npm",
      argv: ["npm", "test"],
    });
    expect(
      grant &&
        matchesAgentApprovalTargetGrant(
          request("terminal_execute", "npmx test"),
          grant,
        ),
    ).toBe(false);
  });
});
