import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const requireFromRoot = createRequire(join(root, "package.json"));
// Reuse the DOM parser supplied by the installed Jest browser environment.
const { JSDOM } = createRequire(
  requireFromRoot.resolve("jest-environment-jsdom/package.json"),
)("jsdom");
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
// Compare attributes by name so assertions do not depend on serialization order.
const attributes = (tag) =>
  Object.fromEntries(
    [...tag.matchAll(/\s([\w:-]+)="([^"]*)"/g)].map(([, name, value]) => [
      name,
      value,
    ]),
  );

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

  const links = anchors(html).map(attributes);
  for (const pattern of [
    /^https:\/\/example\.com\/docs$/,
    /^https:\/\/example\.org\/?$/,
  ]) {
    const link = links.find(({ href }) => pattern.test(href ?? ""));
    assert.ok(link, `${pattern} in ${html}`);
    assert.equal(link.target, "_blank");
    assert.equal(link.rel, "noopener noreferrer");
    assert.match(link.class, /^text-link\b/);
    // Isolated so URL slashes stay put inside right-to-left prose.
    assert.equal(link.dir, "auto");
  }

  // Web local paths stay inert text rather than navigable links.
  assert.equal(
    links.some(({ href }) => href?.includes("notes.md")),
    false,
    html,
  );
  const localPath = html.match(
    /<span\b([^>]*)>\/home\/user\/notes\.md<\/span>/,
  );
  assert.ok(localPath, html);
  const localAttributes = attributes(localPath[1]);
  assert.equal(localAttributes.class, "text-muted-foreground");
  assert.equal(localAttributes.dir, "auto");
});

// Exact href and visible label of every navigable link, plus the visible text.
const rendered = (html) => {
  const dom = new JSDOM(html);
  try {
    const { body } = dom.window.document;
    return {
      links: [...body.querySelectorAll("a[href]")].map((anchor) => [
        anchor.getAttribute("href"),
        anchor.textContent,
      ]),
      text: body.textContent,
    };
  } finally {
    dom.window.close();
  }
};
const renderStates = [{ isAnimating: false }, { isAnimating: true }];

// Explicit Markdown destinations already keep these suffixes, so they are the
// reference for what the sanitizers emit for the same URL (null if blocked).
const explicitHref = (url) =>
  rendered(
    renderAssistantMarkdown(
      `[x](${url.replace(/^www\./i, (www) => `http://${www}`)})`,
    ),
  ).links[0]?.[0] ?? null;

test("bare URLs keep trailing underscores and tildes while sentence punctuation stays outside", () => {
  for (const url of [
    "https://example.com/name_",
    "https://example.com/name~",
    "https://example.com/name__",
    "https://example.com/name~~",
    "https://example.com/name_~",
    "https://example.com/name~_~",
    "https://example.com/search?q=name_",
    "https://example.com/page#section~",
    "www.example.com/name_",
    "https://Example.COM/Docs/Name_",
    "WWW.EXAMPLE.COM/NAME~",
    // The existing sanitizers block uppercase schemes in explicit links too;
    // the bare form must stay just as blocked, with its text intact.
    "HTTPS://EXAMPLE.COM/NAME_",
  ]) {
    const href = explicitHref(url);
    assert.equal(href === null, url.startsWith("HTTPS:"), url);
    if (href !== null) assert.match(href, /[_~]$/, url);
    // Rendered one at a time: Markdown repair counts delimiters across the
    // whole message, so repeated URLs could hide an appended delimiter.
    for (const markdown of [
      url,
      `See ${url}.`,
      `See ${url} next`,
      `Also (${url}), then more.`,
      `Open ${url}? Yes`,
    ]) {
      for (const options of renderStates) {
        const result = rendered(
          renderAssistantMarkdown(markdown, undefined, options),
        );
        const name = `${markdown} ${JSON.stringify(options)}`;
        assert.deepEqual(
          result.links,
          href === null ? [] : [[href, url]],
          name,
        );
        // No suffix is lost and no repair delimiter is appended. A blocked
        // link keeps its whole label, followed by the sanitizer's marker.
        assert.equal(
          result.text,
          href === null ? markdown.replace(url, `${url} [blocked]`) : markdown,
          name,
        );
      }
    }
  }
});

test("streaming prefixes never split a bare URL suffix or append a repair delimiter", () => {
  const markdown =
    "See https://example.com/name_~ and https://example.com/a~~ next.";
  for (let end = 1; end <= markdown.length; end++) {
    const prefix = markdown.slice(0, end);
    const { links, text } = rendered(
      renderAssistantMarkdown(prefix, undefined, { isAnimating: true }),
    );
    assert.equal(text, prefix.trimEnd(), prefix);
    for (const [href, label] of links) {
      assert.ok(prefix.includes(label), prefix);
      assert.equal(href, explicitHref(label), prefix);
    }
    // Each URL is complete, suffix included, once whitespace follows it.
    const lastWord = prefix.trimEnd().split(" ").at(-1);
    if (prefix.endsWith(" ") && lastWord.startsWith("https://")) {
      assert.equal(links.at(-1)?.[1], lastWord, prefix);
    }
  }
});

test("formatting delimiters around bare URLs remain formatting", () => {
  for (const [markdown, text, href, states] of [
    // Delimiters that close emphasis or strikethrough stay out of the URL.
    [
      "_see https://example.com/name_",
      "see https://example.com/name",
      "https://example.com/name",
    ],
    [
      "__see https://example.com/name__",
      "see https://example.com/name",
      "https://example.com/name",
    ],
    [
      "~~https://example.com/name~~",
      "https://example.com/name",
      "https://example.com/name",
    ],
    // A literal suffix inside other formatting still belongs to the URL.
    [
      "**https://example.com/name_**",
      "https://example.com/name_",
      "https://example.com/name_",
    ],
    [
      "*see https://example.com/name_*",
      "see https://example.com/name_",
      "https://example.com/name_",
    ],
    [
      "~~gone https://example.com/name_~~",
      "gone https://example.com/name_",
      "https://example.com/name_",
    ],
    [
      "See https://example.com/name_ and _more_",
      "See https://example.com/name_ and more",
      "https://example.com/name_",
    ],
    // Streaming repair closes real openers after the URL, not inside it.
    [
      "_see https://example.com/name",
      "see https://example.com/name",
      "https://example.com/name",
      [{ isAnimating: true }],
    ],
    [
      "**see https://example.com/name_",
      "see https://example.com/name_",
      "https://example.com/name_",
      [{ isAnimating: true }],
    ],
    [
      "See https://example.com/name_ and _more",
      "See https://example.com/name_ and more",
      "https://example.com/name_",
      [{ isAnimating: true }],
    ],
    [
      "~~see https://example.com/name~",
      "see https://example.com/name",
      "https://example.com/name",
      [{ isAnimating: true }],
    ],
  ]) {
    for (const options of states ?? renderStates) {
      const name = `${markdown} ${JSON.stringify(options)}`;
      const result = rendered(
        renderAssistantMarkdown(markdown, undefined, options),
      );
      assert.equal(result.text, text, name);
      assert.deepEqual(result.links, [[href, href]], name);
    }
  }
});

test("code, explicit, angle and reference links keep their own URL rules", () => {
  const html = renderAssistantMarkdown(
    [
      "Inline `https://example.com/code_` stays code.",
      "```text\nhttps://example.com/fence_\n```",
      "Read [docs](https://example.com/explicit_) and <https://example.com/angle~>.",
      "Use [ref][guide].",
      "[guide]: https://example.com/reference~",
    ].join("\n\n"),
  );
  assert.deepEqual(rendered(html).links, [
    ["https://example.com/explicit_", "docs"],
    ["https://example.com/angle~", "https://example.com/angle~"],
    ["https://example.com/reference~", "ref"],
  ]);
  assert.match(html, /<code[^>]*>https:\/\/example\.com\/code_<\/code>/);

  // An explicit link whose label is a URL is not a bare URL: a following
  // underscore stays text.
  for (const options of renderStates) {
    assert.deepEqual(
      rendered(
        renderAssistantMarkdown(
          "[https://example.com/label](https://example.com/label)_",
          undefined,
          options,
        ),
      ),
      {
        links: [["https://example.com/label", "https://example.com/label"]],
        text: "https://example.com/label_",
      },
    );
  }
});

test("bare URL suffixes do not widen sanitized HTML or URL schemes", () => {
  const html = renderAssistantMarkdown(
    'Open https://example.com/name_<script>alert(1)</script> or <a href="javascript:alert(1)_">x</a> and javascript:alert(1)_ now.',
  );
  assert.deepEqual(rendered(html).links, [
    ["https://example.com/name_", "https://example.com/name_"],
  ]);
  assert.doesNotMatch(html, /<script|javascript:alert\(1\)_"/);
});

test("long punctuation and entity tails stay outside bare URLs", () => {
  const semicolons = ";".repeat(4096);
  for (const [markdown, href, text] of [
    [`See https://example.com/a_${semicolons} next`, "https://example.com/a_"],
    [`See https://example.com/a${semicolons} next`, "https://example.com/a"],
    [
      `See https://example.com/a_${".,;".repeat(2048)} next`,
      "https://example.com/a_",
    ],
    // An `&name;` tail is trailing punctuation; it renders decoded as text.
    [
      "See https://example.com/a_&amp; next",
      "https://example.com/a_",
      "See https://example.com/a_& next",
    ],
    [
      "See https://example.com/a&amp;;&lt; next",
      "https://example.com/a",
      "See https://example.com/a&;< next",
    ],
    ["See https://example.com/a_&zz; next", "https://example.com/a_"],
    // Before an entity tail, a `_` can still close earlier emphasis.
    [
      "_see https://example.com/a_&amp; now",
      "https://example.com/a",
      "see https://example.com/a& now",
    ],
    // `&` followed by more than a name is part of the query.
    [
      "See https://example.com/q?x=1&y=2_; next",
      "https://example.com/q?x=1&y=2_",
    ],
  ]) {
    for (const options of renderStates) {
      const name = `${markdown.slice(0, 48)} ${JSON.stringify(options)}`;
      const result = rendered(
        renderAssistantMarkdown(markdown, undefined, options),
      );
      assert.deepEqual(result.links, [[href, href]], name);
      assert.equal(result.text, text ?? markdown, name);
    }
  }
});

test("characters the repair step uses internally render as typed", () => {
  // U+FDD0 and U+FDD1 temporarily stand in for URL delimiters during repair.
  const internal = String.fromCharCode(0xfdd0, 0xfdd1);
  for (const markdown of [
    `Keep ${internal} as typed.`,
    `Keep ${internal} then https://example.com/a_`,
  ]) {
    for (const options of renderStates) {
      const result = rendered(
        renderAssistantMarkdown(markdown, undefined, options),
      );
      assert.equal(result.text, markdown, JSON.stringify(options));
    }
  }
});

const tagDirections = (html, tagName) =>
  (html.match(new RegExp(`<${tagName}\\b[^>]*>`, "g")) ?? []).map(
    (tag) => attributes(tag).dir,
  );

// The direction pass sets `dir` on each top-level block by word majority,
// ignoring code. This checks rendered attributes only; actual bidi layout
// needs a browser.
test("each Markdown block gets its own direction and code stays LTR", () => {
  const html = renderAssistantMarkdown(
    [
      'افتح الملف `/tmp/report.json` باستخدام Auto، ثم راجع `{"status":"ok"}`.',
      // One long Latin token must not outweigh a short Arabic sentence.
      "استخدم claude-opus-5-5 هنا.",
      "افتح /var/log/application/security-findings.json الآن.",
      "Claude Opus 5.5 هو النموذج الذي أعدّ هذا التقرير.",
      "`/tmp/report.json` هو الملف الذي يحتوي على النتيجة.",
      "Run `nmap -sV 10.0.0.5` with Auto, then save the output.",
      "- النتيجة محفوظة\n  - تفاصيل إضافية",
      "> راجع السجل قبل المتابعة.",
      "```bash\ncat /tmp/report.json\n```",
    ].join("\n\n"),
  );

  // Top-level blocks carry their own direction; nested ones inherit it.
  assert.deepEqual(
    tagDirections(html, "p"),
    ["rtl", "rtl", "rtl", "rtl", "rtl", "ltr", undefined],
    html,
  );
  assert.deepEqual(tagDirections(html, "ul"), ["rtl", undefined], html);
  assert.deepEqual(tagDirections(html, "blockquote"), ["rtl"], html);

  // Inline code and the fence stay LTR. Static rendering leaves the
  // highlighted fence body empty, so only its wrapper is checked here.
  assert.equal(
    tagDirections(html, "code").filter((dir) => dir === "ltr").length,
    4,
    html,
  );
  const fence = (html.match(/<div\b[^>]*data-highlight-mode[^>]*>/g) ?? []).map(
    attributes,
  );
  assert.deepEqual(
    fence.map(({ dir }) => dir),
    ["ltr"],
    html,
  );

  // Direction comes from attributes; no bidi control characters enter the text.
  const bidiControls = [...html].filter((character) => {
    const code = character.codePointAt(0);
    return (
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    );
  });
  assert.deepEqual(bidiControls, []);
});

const paragraphs = (html) => {
  const dom = new JSDOM(html);
  try {
    return [...dom.window.document.querySelectorAll("p")].map((paragraph) => ({
      dir: paragraph.getAttribute("dir") ?? undefined,
      inner: paragraph.innerHTML,
      text: paragraph.textContent,
      isolates: [...paragraph.querySelectorAll("bdi")].map((isolate) => [
        isolate.getAttribute("dir"),
        isolate.textContent,
      ]),
    }));
  } finally {
    dom.window.close();
  }
};

// In right-to-left prose a bare path's leading slash otherwise renders at the
// far end of the path (observed in the app as `var/log/…json/`).
test("bare local paths in RTL prose are isolated without changing the text", () => {
  const isolated = [
    "افتح /var/log/application/security-findings.json الآن.",
    "راجع (~/reports/scan.txt) و ../out/report.json، ثم ./run.sh و /tmp/a.json.",
  ];
  const html = renderAssistantMarkdown(
    [
      ...isolated,
      "Open /var/log/app.json and ~/notes.txt now.",
      "افتح `/tmp/code.json` أو [/home/user/notes.md](/home/user/notes.md) أو https://example.com/a/b الآن.",
      "اختر نعم /لا أو and/or هنا.",
    ].join("\n\n"),
  );
  const [first, second, english, other, prose] = paragraphs(html);

  // Paths are wrapped LTR; surrounding brackets and punctuation stay outside,
  // and the rendered text is byte-identical to the source.
  assert.equal(first.dir, "rtl", html);
  assert.deepEqual(first.isolates, [
    ["ltr", "/var/log/application/security-findings.json"],
  ]);
  assert.equal(first.text, isolated[0]);
  assert.equal(second.dir, "rtl", html);
  assert.deepEqual(second.isolates, [
    ["ltr", "~/reports/scan.txt"],
    ["ltr", "../out/report.json"],
    ["ltr", "./run.sh"],
    ["ltr", "/tmp/a.json"],
  ]);
  assert.equal(second.text, isolated[1]);

  // English blocks, code, links, URLs and slash-joined words are untouched.
  assert.equal(english.dir, "ltr", html);
  assert.deepEqual(english.isolates, []);
  assert.equal(other.dir, "rtl", html);
  assert.deepEqual(other.isolates, [], other.inner);
  assert.equal(prose.dir, "rtl", html);
  assert.deepEqual(prose.isolates, [], prose.inner);
});

// A soft line break inside one paragraph is not a sentence boundary, so the
// wrapped and single-line forms of the same prose must agree.
test("soft-wrapped and single-line paragraphs and quotes get the same direction", () => {
  const lines = ["افتح الملف الآن باستخدام هذا الأمر", "Run", "Auto"];
  const html = renderAssistantMarkdown(
    [
      lines.join("\n"),
      lines.join(" "),
      lines.map((line) => `> ${line}`).join("\n"),
      `> ${lines.join(" ")}`,
    ].join("\n\n"),
  );

  assert.deepEqual(
    tagDirections(html, "p"),
    ["rtl", "rtl", undefined, undefined],
    html,
  );
  assert.deepEqual(tagDirections(html, "blockquote"), ["rtl", "rtl"], html);
});

// A long English identifier/prose prefix must not hide the later Arabic prose
// from direction detection merely because it is in another inline element.
test("uses the complete prose block when Arabic follows a long English prefix", () => {
  const html = renderAssistantMarkdown(
    `${"English ".repeat(600)}**${"مرحبا ".repeat(700)}**`,
  );
  assert.deepEqual(tagDirections(html, "p"), ["rtl"]);
});
