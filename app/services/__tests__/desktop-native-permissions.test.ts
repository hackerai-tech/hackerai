import { readFileSync } from "node:fs";
import { resolve } from "node:path";

it("exposes the native environment identity command to the Desktop webview", () => {
  const nativeRoot = resolve(__dirname, "../../../packages/desktop/src-tauri");
  const capability = JSON.parse(
    readFileSync(resolve(nativeRoot, "capabilities/default.json"), "utf8"),
  );
  const permission = readFileSync(
    resolve(nativeRoot, "permissions/desktop-command-bridge.toml"),
    "utf8",
  );
  const allowedCommands =
    permission.match(/commands\.allow\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? "";
  const nativeEntry = readFileSync(resolve(nativeRoot, "src/lib.rs"), "utf8");

  expect(capability.permissions).toContain("allow-desktop-command-bridge");
  expect(allowedCommands.match(/"[^"]+"/g)).toContain('"get_environment_id"');
  expect(nativeEntry).toMatch(
    /generate_handler!\[[\s\S]*?environment_identity::get_environment_id/,
  );
});
