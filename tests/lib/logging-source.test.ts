import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import ts from "typescript";

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(`${directory}/${entry.name}`) : [`${directory}/${entry.name}`]);
}

describe("logging privacy regression guard", () => {
  it("allows no raw server console calls or dynamic log event names", () => {
    const failures: string[] = [];
    for (const path of files("src").filter((file) => /\.(ts|tsx)$/.test(file))) {
      const source = readFileSync(path, "utf8");
      const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
      const client = source.startsWith('"use client"') || path.includes("/client/");
      function visit(node: ts.Node) {
        if (ts.isCallExpression(node)) {
          const callee = node.expression.getText(tree);
          if (callee.startsWith("console.") && path !== "src/lib/logger.ts") {
            if (!client || node.arguments.length !== 1 || !ts.isStringLiteral(node.arguments[0])) failures.push(`${path}: raw console`);
          }
          if (callee === "logEvent" && path !== "src/lib/request-logging.ts" && !ts.isStringLiteral(node.arguments[0])) failures.push(`${path}: dynamic event`);
          if (/^process\.(stdout|stderr)\.write$/.test(callee)) failures.push(`${path}: direct output`);
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
    }
    expect(failures).toEqual([]);
  });
});
