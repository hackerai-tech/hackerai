import { getCodeDownloadFilename } from "../code-download-filename";

describe("getCodeDownloadFilename", () => {
  it("uses conventional file extensions for common language names", () => {
    expect(getCodeDownloadFilename("python")).toBe("code.py");
    expect(getCodeDownloadFilename("javascript")).toBe("code.js");
    expect(getCodeDownloadFilename("typescript")).toBe("code.ts");
    expect(getCodeDownloadFilename("bash")).toBe("code.sh");
    expect(getCodeDownloadFilename("powershell")).toBe("code.ps1");
    expect(getCodeDownloadFilename("csharp")).toBe("code.cs");
    expect(getCodeDownloadFilename("rust")).toBe("code.rs");
    expect(getCodeDownloadFilename("terraform")).toBe("code.tf");
  });

  it("preserves explicit extensions and falls back to txt", () => {
    expect(getCodeDownloadFilename("py")).toBe("code.py");
    expect(getCodeDownloadFilename("txt")).toBe("code.txt");
    expect(getCodeDownloadFilename("unknownlang")).toBe("code.unknownlang");
    expect(getCodeDownloadFilename()).toBe("code.txt");
  });
});
