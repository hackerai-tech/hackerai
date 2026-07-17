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
});
