import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(join(root, "package.json"));
// tsx already depends on esbuild; reuse it rather than adding a dependency.
const esbuild = createRequire(requireFromRoot.resolve("tsx/package.json"))(
  "esbuild",
);

// Node resolves the external packages from the bundle's location, so the
// bundle lives under this checkout's ignored dependency cache.
const cacheRoot = join(root, "node_modules", ".cache");
let outputDir;
let renderAssistantMarkdown;

before(async () => {
  mkdirSync(cacheRoot, { recursive: true });
  outputDir = mkdtempSync(join(cacheRoot, "markdown-sandbox-download-"));
  const outfile = join(outputDir, "fixture.mjs");
  await esbuild.build({
    entryPoints: [join(root, "scripts/markdown/sandbox-download.fixture.tsx")],
    outfile,
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    jsx: "automatic",
    tsconfig: join(root, "tsconfig.json"),
    logLevel: "silent",
    plugins: [
      {
        // Bundle application modules (`@/...`); load packages as installed so
        // the test exercises the real Streamdown and sanitizer versions.
        name: "external-packages",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, ({ path }) =>
            path.startsWith("@/") ? undefined : { path, external: true },
          );
        },
      },
    ],
  });
  ({ renderAssistantMarkdown } = await import(pathToFileURL(outfile).href));
});

after(() => {
  if (outputDir) rmSync(outputDir, { recursive: true, force: true });
});

const reportPath = "/home/user/report.txt";
const reportHref = "#hackerai-sandbox-file=%2Fhome%2Fuser%2Freport.txt";
const delivery = (fileId = "file-1", sourcePath = reportPath) => ({
  parts: [
    {
      type: "tool-get_terminal_files",
      state: "output-available",
      output: {
        deliveryReceipts: [
          {
            fileId,
            sourcePath,
            name: "report.txt",
            sizeBytes: 26,
            storageStatus: "stored",
          },
        ],
      },
    },
  ],
  fileDetails: [{ fileId: "file-1", name: "report.txt" }],
});
const anchors = (html) => html.match(/<a\b[^>]*>/g) ?? [];

test("a delivered sandbox link survives the default sanitizers as a download link", () => {
  const html = renderAssistantMarkdown(
    "Saved [report.txt](sandbox:/home/user/report.txt).",
    delivery(),
  );

  const found = anchors(html);
  assert.equal(found.length, 1, html);
  const [link] = found;
  assert.match(link, new RegExp(`href="${reportHref}"`));
  assert.match(link, /class="text-link hover:text-link\/80 hover:underline/);
  assert.doesNotMatch(link, /target=/);
  assert.match(
    html,
    />report\.txt<span class="sr-only">, download report\.txt</,
  );
  assert.doesNotMatch(html, /\[blocked\]|sandbox:/);
});

test("well-formed sandbox links without a matching delivery stay inert text", () => {
  for (const [name, markdown, data] of [
    ["no message context", "[report.txt](sandbox:/home/user/report.txt)"],
    ["another path", "[secret](sandbox:/home/user/secret.txt)", delivery()],
    [
      "another message's file",
      "[report.txt](sandbox:/home/user/report.txt)",
      delivery("file-from-another-message"),
    ],
  ]) {
    const html = renderAssistantMarkdown(markdown, data);
    assert.deepEqual(anchors(html), [], name);
    assert.match(html, /<span class="text-muted-foreground">/, name);
    assert.doesNotMatch(html, /sandbox:/, name);
  }
});

test("malicious and malformed URLs stay blocked by the existing sanitizers", () => {
  for (const url of [
    "sandbox://attacker.example/home/user/report.txt",
    "sandbox:/home/user/../../etc/passwd",
    "sandbox:/home/user/%2e%2e/report.txt",
    "javascript:alert(1)",
    "data:text/html,boom",
  ]) {
    const html = renderAssistantMarkdown(`[open](${url})`, delivery());
    assert.deepEqual(anchors(html), [], url);
    assert.doesNotMatch(
      html,
      /hackerai-sandbox-file|javascript:|data:text/,
      url,
    );
  }
});

test("code, images and raw HTML are not turned into downloads", () => {
  const html = renderAssistantMarkdown(
    [
      "```text",
      "[report.txt](sandbox:/home/user/report.txt)",
      "```",
      "",
      "Inline `[report.txt](sandbox:/home/user/report.txt)` code.",
      "",
      "![chart](sandbox:/home/user/report.txt)",
      "",
      '<a href="sandbox:/home/user/report.txt">raw</a>',
    ].join("\n"),
    delivery(),
  );

  // The source text must still render as code, so the negatives below are not
  // satisfied by an empty render.
  assert.match(
    html,
    /<code[^>]*>\[report\.txt\]\(sandbox:\/home\/user\/report\.txt\)<\/code>/,
  );
  assert.equal(
    html.match(/\(sandbox:\/home\/user\/report\.txt\)/g)?.length,
    2,
    "fenced and inline code both render their source text",
  );
  assert.match(html, /raw/);
  assert.doesNotMatch(
    html,
    /hackerai-sandbox-file|href="sandbox:|src="sandbox:/,
  );
  assert.equal(
    anchors(html).filter((anchor) => /href=/.test(anchor)).length,
    0,
    html,
  );
});

test("HTTPS links, GFM autolinks and local paths keep their behavior", () => {
  const html = renderAssistantMarkdown(
    "Read [docs](https://example.com/docs), visit https://example.org and see [/home/user/notes.md](/home/user/notes.md).",
    delivery(),
  );

  assert.match(
    html,
    /<a href="https:\/\/example\.com\/docs" target="_blank" rel="noopener noreferrer" class="text-link/,
  );
  assert.match(html, /<a href="https:\/\/example\.org\/?" target="_blank"/);
  assert.match(
    html,
    /<span class="text-muted-foreground">\/home\/user\/notes\.md<\/span>/,
  );
});
