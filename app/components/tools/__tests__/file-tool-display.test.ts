import { getFileToolDisplayTarget } from "../file-tool-display";

describe("getFileToolDisplayTarget", () => {
  it("hides shortened attachment namespaces", () => {
    expect(
      getFileToolDisplayTarget("/home/user/upload/0123456789abcdef/report.pdf"),
    ).toBe("report.pdf");
  });

  it("hides full collision-fallback namespaces and preserves line ranges", () => {
    expect(
      getFileToolDisplayTarget(
        `/tmp/hackerai-upload/${"a".repeat(64)}/report.pdf L2-4`,
      ),
    ).toBe("report.pdf L2-4");
  });

  it("preserves ordinary sandbox paths", () => {
    expect(getFileToolDisplayTarget("/home/user/results/report.pdf")).toBe(
      "/home/user/results/report.pdf",
    );
  });
});
