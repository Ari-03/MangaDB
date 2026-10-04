// Guards the browser bundle against Convex server code. Importing anything
// from a convex/ function module (convex/comments.ts, say) runs that module in
// the browser: its schema, its query/mutation registrations, and everything
// they import, plus Convex's warning "Convex functions should not be imported
// in the browser" for each one. The browser may import only
// convex/_generated/api and _generated/dataModel, and convex/lib/ modules
// whose own imports stay inside convex/lib/ and `convex/values`.
//
// The walk starts where the client bundle starts (the router and start.ts)
// and follows every import, re-export, import() and new URL(…, import.meta.url)
// that TypeScript keeps; `import type` and `export type` are erased and
// skipped. Specifiers resolve as Vite resolves them: `~/` to src/, a leading
// `/` and a bare name that names a repo file (tsconfig baseUrl ".") to the
// repo root, `.js` to `.ts`, and `?raw`/`?url` suffixes dropped. An import()
// or new URL() whose argument is not one plain string, and any
// import.meta.glob, is reported rather than skipped: Vite turns those into
// imports of every file they match. The walk is stricter than the bundler in
// one way: imports used only inside a createServerFn handler (stripped from
// the client build) are checked too.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/** Packages a browser-safe convex/lib/ module may import. */
const PURE_PACKAGES = new Set(["convex/values"]);
/** convex/_generated/ modules the browser may import (paths without extension). */
const CLIENT_GENERATED = new Set(["_generated/api", "_generated/dataModel"]);
const CODE = /\.(tsx?|jsx?)$/;

/**
 * An import the walk follows, or `opaque`: the source text of an import(),
 * new URL() or import.meta.glob the walk cannot reduce to one file.
 */
type Edge = { specifier: string; typeOnly: boolean } | { opaque: string };

/** `import.meta.<name>`. */
const isImportMeta = (node: ts.Node, name: string): boolean =>
  ts.isPropertyAccessExpression(node) &&
  node.name.text === name &&
  ts.isMetaProperty(node.expression) &&
  node.expression.keywordToken === ts.SyntaxKind.ImportKeyword;

/** Every import, re-export, import(), new URL(…, import.meta.url) and glob in a file, marking the erased ones. */
function importsOf(file: string, text: string): Edge[] {
  const kind = file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, kind);
  const edges: Edge[] = [];
  // A string or substitution-free template, through parentheses, is the one
  // argument form Vite resolves to a single file.
  const follow = (node: ts.Node, arg: ts.Expression | undefined): Edge => {
    let literal = arg;
    while (literal && ts.isParenthesizedExpression(literal)) literal = literal.expression;
    return literal && ts.isStringLiteralLike(literal)
      ? { specifier: literal.text, typeOnly: false }
      : { opaque: node.getText(source) };
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      // `import { type A } from "x"` keeps a bare `import "x"` under
      // verbatimModuleSyntax, so only a wholly type-only clause is erased.
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.importClause?.isTypeOnly ?? false });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      edges.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      edges.push(follow(node, node.arguments[0]));
    } else if (ts.isCallExpression(node) && isImportMeta(node.expression, "glob")) {
      edges.push({ opaque: node.getText(source) });
    } else if (
      // Vite emits the file as an asset, or bundles it whole inside new Worker().
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "URL" &&
      node.arguments?.[1] !== undefined &&
      isImportMeta(node.arguments[1], "url")
    ) {
      edges.push(follow(node, node.arguments[0]));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return edges;
}

/**
 * Every chain from `roots` that brings Convex server code into the browser,
 * as "a → b → convex/x.ts (why)". `read` answers a file's text, or undefined
 * when there is no such file; `root` is the repo root that holds src/ and
 * convex/.
 */
function convexLeaks(roots: string[], root: string, read: (file: string) => string | undefined): string[] {
  const convexDir = path.join(root, "convex") + path.sep;
  const rel = (file: string) => path.relative(root, file);
  // A file path, or null for a package. A bare name is a repo file first
  // (tsconfig baseUrl ".", which Vite honours), so "convex/comments" is
  // convex/comments.ts while "convex/values" is the package.
  const resolve = (from: string, specifier: string): string | null => {
    const bare = specifier.replace(/\?.*$/, "");
    const base = bare.startsWith("~/")
      ? path.join(root, "src", bare.slice(2))
      : bare.startsWith(".")
        ? path.resolve(path.dirname(from), bare)
        : path.join(root, bare);
    const extensions = ["", ".ts", ".tsx", ".js", ".d.ts", "/index.ts", "/index.tsx"];
    // `./x.js` names ./x.ts or ./x.tsx in TypeScript source.
    const stems = [base, base.replace(/\.js$/, ".ts"), base.replace(/\.jsx?$/, ".tsx")];
    const found = stems.flatMap((stem) => extensions.map((ext) => stem + ext)).find((file) => read(file) !== undefined);
    if (found !== undefined) return found;
    if (/^[~./]/.test(bare)) throw new Error(`${rel(from)}: cannot resolve "${specifier}"`);
    return null;
  };

  const leaks: string[] = [];
  const parent = new Map<string, string | null>(roots.map((file) => [file, null]));
  const chain = (file: string): string => {
    const files: string[] = [];
    for (let at: string | null | undefined = file; at; at = parent.get(at)) files.unshift(rel(at));
    return files.join(" → ");
  };
  const queue = [...roots];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (!CODE.test(file) || file.endsWith(".d.ts")) continue;
    // A convex/lib/ module the browser reaches must be data and pure helpers.
    const inLib = file.startsWith(path.join(convexDir, "lib") + path.sep);
    for (const edge of importsOf(file, read(file) ?? "")) {
      if ("opaque" in edge) {
        leaks.push(`${chain(file)} has ${edge.opaque}, which the guard cannot follow (Vite bundles every file it matches: pass import() and new URL() one plain string, and import files by name instead of import.meta.glob)`);
        continue;
      }
      if (edge.typeOnly) continue;
      const target = resolve(file, edge.specifier);
      if (target === null) {
        if (inLib && !PURE_PACKAGES.has(edge.specifier)) {
          leaks.push(`${chain(file)} imports "${edge.specifier}" (a convex/lib/ module the browser loads may import only ${[...PURE_PACKAGES].join(", ")})`);
        }
        continue;
      }
      if (target.startsWith(convexDir)) {
        const module = rel(target).slice("convex/".length).replace(/(\.d)?\.[jt]sx?$/, "");
        if (CLIENT_GENERATED.has(module) && !inLib) continue;
        if (!module.startsWith("lib/")) {
          leaks.push(`${chain(file)} → ${rel(target)} (server code: import it from a pure convex/lib/ module instead)`);
          continue;
        }
      } else if (inLib) {
        leaks.push(`${chain(file)} → ${rel(target)} (a convex/lib/ module the browser loads must stay inside convex/lib/)`);
        continue;
      }
      if (!parent.has(target)) {
        parent.set(target, file);
        queue.push(target);
      }
    }
  }
  return leaks;
}

describe("client imports of convex/", () => {
  it("bring no Convex server code into the browser", () => {
    const root = fileURLToPath(new URL("..", import.meta.url));
    const read = (file: string) =>
      statSync(file, { throwIfNoEntry: false })?.isFile() ? readFileSync(file, "utf8") : undefined;
    const roots = ["src/router.tsx", "src/start.ts"].map((file) => path.join(root, file));
    expect(convexLeaks(roots, root, read)).toEqual([]);
  });

  // A small virtual repo, so each rule is shown to catch what it should.
  const leaksIn = (files: Record<string, string>) =>
    convexLeaks(["/r/src/router.tsx"], "/r", (file) => files[file]);
  const repo = (router: string, more: Record<string, string> = {}) => ({
    "/r/src/router.tsx": router,
    "/r/convex/_generated/api.js": "export const api = {};",
    "/r/convex/_generated/dataModel.d.ts": "export type Id<T> = string;",
    "/r/convex/comments.ts": 'import { query } from "./_generated/server";\nexport const COMMENT_POLICY = {};',
    "/r/convex/_generated/server.js": "export const query = () => {};",
    "/r/convex/lib/policy.ts": 'import { v } from "convex/values";\nexport const POLICY = v.string();',
    ...more,
  });

  it("allow the generated api, type-only imports and pure convex/lib/ modules", () => {
    const router = [
      'import { api } from "../convex/_generated/api";',
      'import type { Id } from "../convex/_generated/dataModel";',
      'import type { COMMENT_POLICY } from "../convex/comments";',
      'export type { COMMENT_POLICY as P } from "../convex/comments";',
      'import { POLICY } from "../convex/lib/policy";',
      'import "./styles.css?url";',
      'import { useQuery } from "convex/react";',
      'const lazy = () => import(("~/lib/lazy"));',
    ].join("\n");
    expect(leaksIn(repo(router, { "/r/src/styles.css": "", "/r/src/lib/lazy.ts": "export {};" }))).toEqual([]);
  });

  it("catch a function module reached through src/", () => {
    const files = repo('import { x } from "~/lib/comments";', {
      "/r/src/lib/comments.tsx": 'import { COMMENT_POLICY } from "../../convex/comments";\nexport const x = 1;',
    });
    expect(leaksIn(files)).toEqual([
      "src/router.tsx → src/lib/comments.tsx → convex/comments.ts (server code: import it from a pure convex/lib/ module instead)",
    ]);
  });

  it("catch re-exports, import(), inline type imports and _generated/server", () => {
    const router = [
      'export { COMMENT_POLICY } from "../convex/comments";',
      'const lazy = () => import("../convex/comments");',
      'import { type COMMENT_POLICY } from "../convex/comments";',
      'import { query } from "../convex/_generated/server";',
    ].join("\n");
    expect(leaksIn(repo(router))).toHaveLength(4);
  });

  // Each of these makes Vite bundle convex/comments.ts (?raw ships its source
  // text, new Worker(new URL(…)) runs it in a worker).
  it.each([
    ["export *", 'export * from "../convex/comments";'],
    ["a template import()", "import(`../convex/comments`);"],
    ["a parenthesized import()", 'import(("../convex/comments"));'],
    ["a ~/ path that leaves src/", 'import "~/../convex/comments";'],
    ["a root-relative path", 'import { COMMENT_POLICY } from "/convex/comments.ts";'],
    ["a bare name through tsconfig baseUrl", 'import { COMMENT_POLICY } from "convex/comments";'],
    ["a .js extension", 'import { COMMENT_POLICY } from "../convex/comments.js";'],
    ["a ?raw suffix", 'import text from "../convex/comments.ts?raw";'],
    ["a worker URL", 'new Worker(new URL("../convex/comments.ts", import.meta.url));'],
  ])("catch server code reached by %s", (_, router) => {
    expect(leaksIn(repo(router))).toEqual([
      "src/router.tsx → convex/comments.ts (server code: import it from a pure convex/lib/ module instead)",
    ]);
  });

  it("report an import() it cannot reduce to one file rather than skip it", () => {
    expect(leaksIn(repo('import(`../convex/${"comments"}.ts`);'))).toEqual([
      'src/router.tsx has import(`../convex/${"comments"}.ts`), which the guard cannot follow (Vite bundles every file it matches: pass import() and new URL() one plain string, and import files by name instead of import.meta.glob)',
    ]);
  });

  it.each([
    ["a concatenated import()", 'const name = "comments";\nimport("../convex/" + name + ".ts");'],
    ["an import() of a variable", "import(specifier);"],
    ["import.meta.glob", 'import.meta.glob("/convex/*.ts", { eager: true });'],
    ["a template new URL()", "new URL(`../convex/${name}.ts`, import.meta.url);"],
  ])("report %s", (_, router) => {
    expect(leaksIn(repo(router))).toEqual([expect.stringContaining("which the guard cannot follow")]);
  });

  it("catch a convex/lib/ module that imports server code, however deep", () => {
    const files = repo('import { a } from "../convex/lib/a";', {
      "/r/convex/lib/a.ts": 'import { b } from "./b";\nexport const a = b;',
      "/r/convex/lib/b.ts": 'import { schema } from "../schema";\nimport { RateLimiter } from "@convex-dev/rate-limiter";\nimport { api } from "../_generated/api";\nexport { query } from "../_generated/server";\nexport const b = 1;',
      "/r/convex/schema.ts": "export const schema = {};",
    });
    expect(leaksIn(files)).toEqual([
      "src/router.tsx → convex/lib/a.ts → convex/lib/b.ts → convex/schema.ts (server code: import it from a pure convex/lib/ module instead)",
      'src/router.tsx → convex/lib/a.ts → convex/lib/b.ts imports "@convex-dev/rate-limiter" (a convex/lib/ module the browser loads may import only convex/values)',
      "src/router.tsx → convex/lib/a.ts → convex/lib/b.ts → convex/_generated/api.js (server code: import it from a pure convex/lib/ module instead)",
      "src/router.tsx → convex/lib/a.ts → convex/lib/b.ts → convex/_generated/server.js (server code: import it from a pure convex/lib/ module instead)",
    ]);
  });

  it("fail loudly on an import it cannot resolve rather than skip it", () => {
    expect(() => leaksIn(repo('import { x } from "./missing";'))).toThrow('src/router.tsx: cannot resolve "./missing"');
  });
});
