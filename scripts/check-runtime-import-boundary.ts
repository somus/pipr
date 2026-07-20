#!/usr/bin/env bun
import path from "node:path";
import ts from "typescript6";

const forbiddenPatterns = [
  /hosts\/(?:azure-devops|bitbucket|github|gitlab|local)(?:\/|$)/,
  /shared\/github(?:\/|$)/,
  /^@octokit\/rest(?:\/|$)/,
];

export function forbiddenRuntimeImports(source: string, fileName = "source.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const violations: string[] = [];

  function visit(node: ts.Node): void {
    const specifier = moduleSpecifier(node);
    if (specifier && forbiddenPatterns.some((pattern) => pattern.test(specifier))) {
      const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      violations.push(`${fileName}:${line + 1}: forbidden provider import '${specifier}'`);
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function moduleSpecifier(node: ts.Node): string | undefined {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length === 1 &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return undefined;
}

export async function checkRuntimeImportBoundary(root: string): Promise<string[]> {
  const reviewRoot = path.join(root, "packages/runtime/src/review");
  const violations: string[] = [];
  const glob = new Bun.Glob("**/*.ts");
  for await (const relativePath of glob.scan({ cwd: reviewRoot, onlyFiles: true })) {
    if (relativePath.split("/").includes("tests") || relativePath.endsWith(".test.ts")) continue;
    const fileName = path.join(reviewRoot, relativePath);
    violations.push(...forbiddenRuntimeImports(await Bun.file(fileName).text(), fileName));
  }
  return violations;
}

if (import.meta.main) {
  const root = path.resolve(import.meta.dirname, "..");
  const violations = await checkRuntimeImportBoundary(root);
  if (violations.length > 0) {
    throw new Error(`core review imports provider-specific code:\n${violations.join("\n")}`);
  }
  console.log("runtime review import boundary passed");
}
