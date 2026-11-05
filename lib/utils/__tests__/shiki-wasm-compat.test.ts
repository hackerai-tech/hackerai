import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

function runShikiScenario(scenario: string) {
  return execFileSync(
    process.execPath,
    [
      "--unhandled-rejections=strict",
      "--input-type=module",
      "--eval",
      `
      import assert from "node:assert/strict";
      ${scenario}
      `,
    ],
    {
      // A fresh native process bypasses Jest's Shiki component mock and cache.
      cwd: resolve(__dirname, "../../.."),
      encoding: "utf8",
      env: { NODE_ENV: "test" },
      timeout: 15_000,
    },
  );
}

it("preserves real code highlighting when the browser lacks Response.bytes", () => {
  const highlight = `
      const { wasmBinaryPromise } = await import("shiki/wasm");
      const binary = await wasmBinaryPromise;
      assert.ok(binary instanceof Uint8Array);
      await WebAssembly.compile(binary);
      const { codeToHtml } = await import("shiki");
      const html = await codeToHtml('const answer = "<tag>";', {
        lang: "javascript",
        theme: "github-dark",
      });
      assert.match(html, /<span style="color:/);
      assert.match(html, /answer/);
      assert.match(html, /tag/);
      assert.doesNotMatch(html, /<tag>/);
      const ansi = await codeToHtml(String.fromCharCode(27) + '[31mred' + String.fromCharCode(27) + '[0m <tag>', {
        lang: "ansi",
        theme: "github-dark",
      });
      assert.match(ansi, /<span style="color:/);
      assert.doesNotMatch(ansi, /<tag>/);
      process.stdout.write(JSON.stringify({ html, ansi }));
  `;
  const supported = runShikiScenario(
    `assert.equal(typeof Response.prototype.bytes, "function"); ${highlight}`,
  );
  expect(
    runShikiScenario(`
      delete Response.prototype.bytes;
      assert.equal(typeof Response.prototype.bytes, "undefined");
      ${highlight}
    `),
  ).toBe(supported);
});

it("keeps genuine WASM loader initialization failures visible", () => {
  runShikiScenario(`
    delete Response.prototype.bytes;
    const failure = new Error("WASM initialization failed");
    const { default: instantiateWasm, wasmBinaryPromise } = await import("shiki/wasm");
    await wasmBinaryPromise;
    WebAssembly.instantiate = async () => { throw failure; };
    await assert.rejects(
      instantiateWasm({}),
      error => error === failure,
    );
  `);
});
