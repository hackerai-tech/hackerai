import type { FileDetails } from "@/types/file";
import {
  parseSandboxAttachmentHref,
  parseSandboxLinkPath,
  remarkSandboxAttachmentLinks,
  resolveSandboxAttachments,
  toSandboxAttachmentHref,
} from "../sandbox-attachment-links";

const file = (fileId: string, name = "report.txt") =>
  ({ fileId, name }) as FileDetails;

const delivery = (
  receipts: unknown[],
  state = "output-available",
): Record<string, unknown> => ({
  type: "tool-get_terminal_files",
  state,
  output: { deliveryReceipts: receipts },
});

const stored = (fileId: string, sourcePath: string) => ({
  fileId,
  sourcePath,
  storageStatus: "stored",
});

describe("parseSandboxLinkPath", () => {
  it.each([
    ["sandbox:/home/user/report.txt", "/home/user/report.txt"],
    ["sandbox:/home/user/my%20report.txt", "/home/user/my report.txt"],
  ])("accepts %s", (url, path) => {
    expect(parseSandboxLinkPath(url)).toBe(path);
  });

  it.each([
    "https://example.com/report.txt",
    "javascript:alert(1)",
    "SANDBOX:/home/user/report.txt",
    "sandbox:home/user/report.txt",
    "sandbox://attacker.example/home/user/report.txt",
    "sandbox:/home/user/../../etc/passwd",
    "sandbox:/home/user/%2e%2e/%2e%2e/etc/passwd",
    "sandbox:/home/user/..%2f..%2fetc/passwd",
    "sandbox:/home/user/./report.txt",
    "sandbox:/home/user//report.txt",
    "sandbox:/home/user/",
    "sandbox:/home\\user/report.txt",
    "sandbox:/home/user/report.txt%00.png",
    "sandbox:/home/user/report.txt?download=1",
    "sandbox:/home/user/report.txt#top",
    "sandbox:/home/user/%E0%A4%A",
  ])("rejects %s", (url) => {
    expect(parseSandboxLinkPath(url)).toBeNull();
  });
});

describe("sandbox attachment href", () => {
  it("round-trips paths that need encoding", () => {
    const path = "/home/user/it's (final) #1?.txt";
    const href = toSandboxAttachmentHref(path);
    expect(href).not.toMatch(/[ '()?]/);
    expect(parseSandboxAttachmentHref(href)).toBe(path);
  });

  it("rejects hand-written tokens that decode to traversal", () => {
    expect(
      parseSandboxAttachmentHref(
        "#hackerai-sandbox-file=%2Fhome%2Fuser%2F..%2Fsecret",
      ),
    ).toBeNull();
  });
});

describe("remarkSandboxAttachmentLinks", () => {
  it("rewrites only valid sandbox link nodes", () => {
    const tree = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "link", url: "sandbox:/home/user/report.txt" },
            { type: "link", url: "sandbox://attacker.example/x" },
            { type: "link", url: "https://example.com" },
            { type: "image", url: "sandbox:/home/user/report.txt" },
            { type: "inlineCode", value: "sandbox:/home/user/report.txt" },
          ],
        },
        { type: "definition", url: "sandbox:/home/user/report.txt" },
      ],
    };

    remarkSandboxAttachmentLinks()(tree);

    const [paragraph, definition] = tree.children as any[];
    expect(paragraph.children.map((node: any) => node.url)).toEqual([
      toSandboxAttachmentHref("/home/user/report.txt"),
      "sandbox://attacker.example/x",
      "https://example.com",
      "sandbox:/home/user/report.txt",
      undefined,
    ]);
    expect(definition.url).toBe("sandbox:/home/user/report.txt");
  });
});

describe("resolveSandboxAttachments", () => {
  const path = "/home/user/report.txt";

  it("resolves an exact stored receipt to this message's file metadata", () => {
    const report = file("file-1");
    const resolved = resolveSandboxAttachments(
      [delivery([stored("file-1", path)])],
      [report],
    );
    expect(resolved.get(path)).toBe(report);
  });

  it.each([
    {
      name: "the file belongs to another message",
      parts: [delivery([stored("file-other", path)])],
      fileDetails: [file("file-1")],
    },
    {
      name: "file metadata has not arrived",
      parts: [delivery([stored("file-1", path)])],
      fileDetails: undefined,
    },
    {
      name: "the delivery did not finish",
      parts: [delivery([stored("file-1", path)], "input-available")],
      fileDetails: [file("file-1")],
    },
    {
      name: "the receipt is not stored",
      parts: [
        delivery([{ fileId: "file-1", sourcePath: path, storageStatus: "x" }]),
      ],
      fileDetails: [file("file-1")],
    },
    {
      name: "the same path was delivered as two files",
      parts: [
        delivery([stored("file-1", path)]),
        delivery([stored("file-2", path)]),
      ],
      fileDetails: [file("file-1"), file("file-2")],
    },
    {
      name: "the receipt comes from another tool",
      parts: [{ ...delivery([stored("file-1", path)]), type: "tool-file" }],
      fileDetails: [file("file-1")],
    },
  ])("stays unresolved when $name", ({ parts, fileDetails }) => {
    expect(resolveSandboxAttachments(parts, fileDetails).has(path)).toBe(false);
  });

  it("matches the delivered path exactly, never by file name", () => {
    const resolved = resolveSandboxAttachments(
      [delivery([stored("file-1", path)])],
      [file("file-1")],
    );
    expect(resolved.has("/tmp/report.txt")).toBe(false);
    expect(resolved.has("/home/user/Report.txt")).toBe(false);
  });
});
