import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

// The database adapter separately tests forwarding/persistence. This contract
// covers the worker call sites: omitting the run ID silently suppresses surveys
// despite a completed result. Parse calls, not line offsets or formatting.
it("binds every assistant save path to the run used for feedback reservation", () => {
  const source = ts.createSourceFile(
    "agent-long.ts",
    fs.readFileSync(path.join(__dirname, "..", "agent-long.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const saves: ts.ObjectLiteralExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "saveMessage" &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      const save = node.arguments[0];
      // Hidden goal continuation prompts are user-role control messages, not
      // visible results eligible for a feedback survey.
      const hidden = save.properties.some(
        (p) =>
          ts.isPropertyAssignment(p) &&
          p.name.getText(source) === "isHidden" &&
          p.initializer.kind === ts.SyntaxKind.TrueKeyword,
      );
      if (!hidden) saves.push(save);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  expect(saves).toHaveLength(4);
  for (const save of saves) {
    const run = save.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) && p.name.getText(source) === "triggerRunId",
    ) as ts.PropertyAssignment | undefined;
    expect(run).toBeDefined();
    expect(run!.initializer.getText(source).replace(/\s+/g, " ")).toMatch(
      /^(ctx\.run\.id|processed\.role === "assistant" \? ctx\.run\.id : undefined)$/,
    );
  }
});
