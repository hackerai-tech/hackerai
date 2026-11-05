import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("native build checking preserves compiler-API tools", async () => {
  assert.match(require("typescript-build/package.json").version, /^7\./);
  for (const name of ["eslint-config-next", "ts-node", "@trigger.dev/build"]) {
    const toolRequire = createRequire(require.resolve(name));
    const compiler = toolRequire("typescript");
    assert.match(compiler.version, /^6\./, name);
    assert.equal(typeof compiler.transpileModule, "function", name);
  }

  const eslint = new ESLint({
    cwd: root,
    overrideConfig: { rules: { "no-debugger": "error" } },
  });
  const [result] = await eslint.lintText(
    "const answer: number = 42; debugger;\n",
    {
      filePath: "scripts/toolchain-fixture.ts",
    },
  );
  assert.ok(
    result.messages.some((message) => message.ruleId === "no-debugger"),
  );

  const script = "const answer: number = 42; console.log(answer);";
  const execution = spawnSync(
    process.execPath,
    [
      require.resolve("ts-node/dist/bin.js"),
      "--skip-project",
      "--transpile-only",
      "--compiler-options",
      JSON.stringify({
        module: "CommonJS",
        moduleResolution: "node",
        ignoreDeprecations: "6.0",
      }),
      "-e",
      script,
    ],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout.trim(), "42");

  const classic = spawnSync(
    process.execPath,
    ["node_modules/typescript/bin/tsc", "--version"],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(classic.status, 0, classic.stderr);
  assert.match(classic.stdout, /Version 6\./);
});

test(
  "the native compiler accepts the complete project with generated route types",
  { timeout: 120_000 },
  () => {
    for (const args of [
      [require.resolve("next/dist/bin/next"), "typegen"],
      [
        resolve(
          dirname(require.resolve("typescript-build/package.json")),
          "bin/tsc",
        ),
        "--project",
        "tsconfig.json",
        "--noEmit",
        "--incremental",
        "false",
      ],
    ]) {
      const result = spawnSync(process.execPath, args, {
        cwd: root,
        encoding: "utf8",
        timeout: 110_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
  },
);

test(
  "a real project type error stops the build before compilation",
  { timeout: 120_000 },
  () => {
    const fixture = resolve(root, `scripts/build-error-${randomUUID()}.ts`);
    const env = { ...process.env, HACKERAI_BUILD_TYPECHECKED: "1" };
    delete env.VERCEL_ENV;
    try {
      writeFileSync(
        fixture,
        'export const invalid: number = "intentional type error";\n',
      );
      const result = spawnSync(process.execPath, ["scripts/build.mjs"], {
        cwd: root,
        env,
        encoding: "utf8",
        timeout: 110_000,
      });
      const output = result.stdout + result.stderr;
      assert.equal(result.error, undefined);
      assert.notEqual(result.status, 0);
      assert.match(output, /TS2322/);
      assert.ok(output.includes(fixture.split("/").pop()));
      assert.doesNotMatch(output, /Creating an optimized production build/);
    } finally {
      rmSync(fixture, { force: true });
    }
  },
);
