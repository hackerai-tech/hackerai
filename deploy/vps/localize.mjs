// Translate presentation text without changing route, state, tool or database identifiers.
import ts from "typescript";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
const dictionary = JSON.parse(
  await readFile(new URL("./pt-BR.json", import.meta.url), "utf8"),
);
const attributes = new Set([
  "title",
  "label",
  "placeholder",
  "aria-label",
  "alt",
  "description",
]);
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "__tests__") continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path);
      continue;
    }
    if (!path.endsWith(".tsx")) continue;
    const source = await readFile(path, "utf8");
    const ast = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const changes = [];
    function visit(node) {
      if (ts.isJsxText(node)) {
        const raw = node.getFullText(ast);
        const original = raw.trim().replace(/\s+/g, " ").replace(/&amp;/g, "&");
        if (dictionary[original])
          changes.push({
            start: node.pos,
            end: node.end,
            value: raw.replace(raw.trim(), dictionary[original]),
          });
      } else if (ts.isStringLiteral(node) && dictionary[node.text]) {
        const parent = node.parent;
        const property =
          ts.isPropertyAssignment(parent) &&
          ["label", "description", "shortLabel", "placeholder"].includes(
            parent.name.getText(ast),
          );
        const attribute =
          ts.isJsxAttribute(parent) && attributes.has(parent.name.getText(ast));
        let ancestor = parent;
        while (
          ancestor &&
          (ts.isConditionalExpression(ancestor) ||
            ts.isParenthesizedExpression(ancestor))
        )
          ancestor = ancestor.parent;
        const display =
          ancestor &&
          ts.isJsxExpression(ancestor) &&
          !ts.isJsxAttribute(ancestor.parent);
        const attrExpression =
          ancestor &&
          ts.isJsxExpression(ancestor) &&
          ts.isJsxAttribute(ancestor.parent) &&
          attributes.has(ancestor.parent.name.getText(ast));
        if (property || attribute || display || attrExpression)
          changes.push({
            start: node.getStart(ast),
            end: node.end,
            value: JSON.stringify(dictionary[node.text]),
          });
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    let translated = source;
    for (const change of changes.sort((a, b) => b.start - a.start))
      translated =
        translated.slice(0, change.start) +
        change.value +
        translated.slice(change.end);
    if (translated !== source) await writeFile(path, translated);
  }
}
await walk("app/components");
await walk("components");
console.log("Textos de interface traduzidos.");
