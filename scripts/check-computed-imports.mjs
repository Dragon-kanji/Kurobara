import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

import ts from "typescript";

const SOURCE_EXTENSIONS = new Set([
  ".cjs",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);
const EXCLUDED_DIRECTORIES = new Set([
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);

const isLiteralSpecifier = (node) =>
  ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);

const isRequireCall = (node) =>
  ts.isIdentifier(node.expression) && node.expression.text === "require";

const isProcessGetBuiltinModuleCall = (node) =>
  ts.isPropertyAccessExpression(node.expression) &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "process" &&
  node.expression.name.text === "getBuiltinModule";

const sourceFiles = (inputPath) => {
  const stats = statSync(inputPath);
  if (stats.isFile()) {
    return SOURCE_EXTENSIONS.has(extname(inputPath)) ? [inputPath] : [];
  }

  return readdirSync(inputPath, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
      return [];
    }
    return sourceFiles(join(inputPath, entry.name));
  });
};

const violations = [];
for (const inputPath of process.argv.slice(2)) {
  for (const filePath of sourceFiles(inputPath)) {
    const sourceText = readFileSync(filePath, "utf8");
    const sourceFile = ts.createSourceFile(
      filePath,
      sourceText,
      ts.ScriptTarget.Latest,
      true
    );

    const inspect = (node) => {
      if (ts.isCallExpression(node)) {
        const isDynamicImport =
          node.expression.kind === ts.SyntaxKind.ImportKeyword;
        const isCheckedLoader =
          isDynamicImport ||
          isRequireCall(node) ||
          isProcessGetBuiltinModuleCall(node);
        const [specifier] = node.arguments;

        if (isCheckedLoader && !(specifier && isLiteralSpecifier(specifier))) {
          const position = sourceFile.getLineAndCharacterOfPosition(
            node.getStart()
          );
          violations.push(
            `${relative(process.cwd(), filePath)}:${position.line + 1}:${position.character + 1}`
          );
        }
      }
      ts.forEachChild(node, inspect);
    };

    inspect(sourceFile);
  }
}

if (violations.length > 0) {
  console.error(
    "Computed module specifiers are forbidden. Use an explicit literal registry:\n" +
      violations.map((violation) => `- ${violation}`).join("\n")
  );
  process.exitCode = 1;
}
