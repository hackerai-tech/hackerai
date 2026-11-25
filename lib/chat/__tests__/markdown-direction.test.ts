import { rehypeMarkdownDirection } from "../markdown-direction";

interface TestNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TestNode[];
}

function renderParagraph(text: string): TestNode {
  const paragraph: TestNode = {
    type: "element",
    tagName: "p",
    properties: {},
    children: [{ type: "text", value: text }],
  };
  rehypeMarkdownDirection()({ type: "root", children: [paragraph] });
  return paragraph;
}

function textContent(node: TestNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textContent).join("");
}

function isolatedPaths(node: TestNode): string[] {
  return (node.children ?? [])
    .filter((child) => child.tagName === "bdi")
    .map((child) => {
      expect(child.properties).toEqual({ dir: "ltr" });
      return textContent(child);
    });
}

describe("rehypeMarkdownDirection bare path isolation", () => {
  it("isolates a rooted path in an RTL paragraph and leaves trailing punctuation outside", () => {
    const text = "افتح الملف /tmp/report.json.. ثم أكمل";
    const paragraph = renderParagraph(text);

    expect(paragraph.properties?.dir).toBe("rtl");
    expect(isolatedPaths(paragraph)).toEqual(["/tmp/report.json"]);
    expect(textContent(paragraph)).toBe(text);
  });

  // Daybreak report: trimming trailing punctuation with /[.,:;!?]+$/ retried
  // from every comma, so a long comma run followed by a letter took quadratic
  // time on a chat render. A linear trim finishes in a few milliseconds.
  it("handles a long punctuation run inside a path in linear time", () => {
    const path = `/tmp/a${",".repeat(64_000)}x`;
    const text = `افتح الملف ${path} ثم أكمل`;

    const startedAt = performance.now();
    const paragraph = renderParagraph(text);
    const elapsedMs = performance.now() - startedAt;

    expect(isolatedPaths(paragraph)).toEqual([path]);
    expect(textContent(paragraph)).toBe(text);
    expect(elapsedMs).toBeLessThan(1_000);
  });
});
