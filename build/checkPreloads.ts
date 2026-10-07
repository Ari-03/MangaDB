// Checks a production build's route preloads against its client files. Runs
// after every `npm run build` (package.json), so CI, `npm run deploy*` and the
// Deploy workflow each check the artifact they ship:
//
//   node build/checkPreloads.ts [dist]
//   node build/checkPreloads.ts [dist] --baseline <dist built without the plugin>
//
// It reads the one TanStack Start manifest in dist/server, calls its
// `tsrStartManifest()`, and for every route takes the module scripts and
// preloads of the route and all its ancestors. Each of those files' static
// imports and re-exports (side-effect imports included, `import()` not: a
// dynamic import loads on demand) must be in that set too, or the browser
// finds them one round trip late (build/transitivePreloads.ts). Every URL
// must name a file in dist/client, and no client file may carry the
// server-only `node:async_hooks` or `cloudflare:workers` (src/server/timing.ts,
// src/server/covers.ts). A manifest, route, or import that cannot be read or
// resolved fails the check rather than passing it.
//
// With --baseline, it also checks that the plugin changed nothing but
// preloads: identical client files, routes, scripts and stylesheets, and each
// route's preloads exactly the baseline's plus their static closure.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import ts from "typescript";

/** Module specifiers no browser file may name (they exist only in the Worker). */
const SERVER_ONLY = ["node:async_hooks", "cloudflare:workers"];
const ROOT = "__root__";

type Link = string | { href: string };
type Script = { attrs?: { src?: string; type?: string } };
type Route = {
  preloads?: Array<Link>;
  scripts?: Array<Script>;
  css?: Array<unknown>;
  children?: Array<string>;
};
export type Manifest = { routes: Record<string, Route> };

/** Every file under `dir`, as paths relative to it with "/" separators. */
function filesUnder(dir: string): Array<string> {
  const files: Array<string> = [];
  const walk = (at: string) => {
    for (const name of readdirSync(at).sort()) {
      const file = path.join(at, name);
      if (statSync(file).isDirectory()) walk(file);
      else files.push(path.relative(dir, file).split(path.sep).join("/"));
    }
  };
  walk(dir);
  return files;
}

const parse = (file: string, text: string) =>
  ts.createSourceFile(file, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.JS);

/** Names a module exports: `export const x`, `export function x`, `export { a as x }`. */
export function exportedNames(file: string, text: string): Array<string> {
  const names: Array<string> = [];
  for (const statement of parse(file, text).statements) {
    if (
      ts.isExportDeclaration(statement) &&
      statement.exportClause &&
      ts.isNamedExports(statement.exportClause)
    ) {
      for (const element of statement.exportClause.elements) names.push(element.name.text);
    }
    const exported = ts.canHaveModifiers(statement)
      ? ts
          .getModifiers(statement)
          ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
      : false;
    if (!exported) continue;
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
      }
    } else if (ts.isFunctionDeclaration(statement) && statement.name) {
      names.push(statement.name.text);
    }
  }
  return names;
}

/**
 * The specifiers of a module's static imports and re-exports, side-effect
 * imports included. `import()` is left out on purpose: it loads on demand.
 */
export function staticSpecifiers(file: string, text: string): Array<string> {
  const specifiers: Array<string> = [];
  for (const statement of parse(file, text).statements) {
    const specifier =
      ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)
        ? statement.moduleSpecifier
        : undefined;
    if (specifier && ts.isStringLiteral(specifier)) specifiers.push(specifier.text);
  }
  return specifiers;
}

/** The manifest module in `serverDir`: the one file exporting `tsrStartManifest`. */
export async function loadManifest(serverDir: string): Promise<Manifest> {
  const found = filesUnder(serverDir)
    .filter((file) => file.endsWith(".js"))
    .filter((file) => {
      const full = path.join(serverDir, file);
      return exportedNames(full, readFileSync(full, "utf8")).includes("tsrStartManifest");
    });
  if (found.length !== 1) {
    throw new Error(
      `expected one module exporting tsrStartManifest in ${serverDir}, found ${found.length}: ${found.join(", ")}`,
    );
  }
  const module: { tsrStartManifest?: unknown } = await import(
    pathToFileURL(path.join(serverDir, found[0]!)).href
  );
  if (typeof module.tsrStartManifest !== "function")
    throw new Error(`${found[0]}: tsrStartManifest is not a function`);
  const manifest: unknown = module.tsrStartManifest();
  return validManifest(manifest, found[0]!);
}

/** `value` as a Manifest, or an error naming what is wrong with it. */
export function validManifest(value: unknown, source: string): Manifest {
  const fail = (why: string): never => {
    throw new Error(`${source}: ${why}`);
  };
  const isObject = (x: unknown): x is Record<string, unknown> =>
    typeof x === "object" && x !== null && !Array.isArray(x);
  if (!isObject(value) || !isObject(value.routes)) fail("no routes");
  const routes = (value as { routes: Record<string, unknown> }).routes;
  if (Object.keys(routes).length === 0) fail("no routes");
  for (const [id, route] of Object.entries(routes)) {
    if (!isObject(route)) fail(`route ${id} is not an object`);
    const { preloads, scripts, children } = route as Record<string, unknown>;
    if (
      preloads !== undefined &&
      !(
        Array.isArray(preloads) &&
        preloads.every(
          (link) => typeof link === "string" || (isObject(link) && typeof link.href === "string"),
        )
      )
    ) {
      fail(`route ${id} has malformed preloads`);
    }
    if (scripts !== undefined && !(Array.isArray(scripts) && scripts.every(isObject)))
      fail(`route ${id} has malformed scripts`);
    if (
      children !== undefined &&
      !(Array.isArray(children) && children.every((child) => typeof child === "string"))
    ) {
      fail(`route ${id} has malformed children`);
    }
  }
  const root = routes[ROOT];
  if (!isObject(root)) fail(`no ${ROOT} route`);
  if (moduleScripts(root as Route).length === 0) fail(`${ROOT} has no module script`);
  return value as Manifest;
}

const hrefOf = (link: Link) => (typeof link === "string" ? link : link.href);
const moduleScripts = (route: Route) =>
  (route.scripts ?? []).flatMap((script) =>
    script.attrs?.type === "module" && script.attrs.src ? [script.attrs.src] : [],
  );

/** Each route's ancestors, root first and itself last; a route no chain reaches is an error. */
export function ancestry(manifest: Manifest): Map<string, Array<string>> {
  const chains = new Map<string, Array<string>>();
  const visit = (id: string, above: Array<string>) => {
    if (above.includes(id)) throw new Error(`route ${id} is its own ancestor`);
    const chain = [...above, id];
    if (chains.has(id)) throw new Error(`route ${id} has two parents`);
    chains.set(id, chain);
    for (const child of manifest.routes[id]?.children ?? []) {
      // A route with nothing to load is left out of the manifest; its own
      // children would then be unreachable, which the check below reports.
      if (manifest.routes[child]) visit(child, chain);
    }
  };
  visit(ROOT, []);
  const orphans = Object.keys(manifest.routes).filter((id) => !chains.has(id));
  if (orphans.length > 0) {
    throw new Error(
      `routes not reachable from ${ROOT} through the manifest's children (their ancestors' preloads are unknown): ${orphans.join(", ")}`,
    );
  }
  return chains;
}

/**
 * The client build as URLs: `resolve` maps a URL path (under `base`) to its
 * file, `staticImports` lists a JS file's static imports as URL paths. Imports
 * resolve against their importer's URL, with POSIX semantics; one that names
 * no file is an error.
 */
export function clientGraph(clientDir: string, base = "/") {
  const files = new Set(filesUnder(clientDir));
  const imports = new Map<string, Array<string>>();

  /** The URL path of `href`, after checking it names a client file. */
  const resolve = (href: string, from = "the manifest"): string => {
    if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//"))
      throw new Error(`${from}: ${href} is not a local URL`);
    if (!href.startsWith(base)) throw new Error(`${from}: ${href} is outside base ${base}`);
    const url = path.posix.normalize(href.split(/[?#]/)[0]!);
    if (!url.startsWith(base) || !files.has(url.slice(base.length))) {
      throw new Error(`${from}: ${href} names no file in the client build`);
    }
    return url;
  };

  /** The URL paths `url` imports statically. */
  const staticImports = (url: string): Array<string> => {
    const known = imports.get(url);
    if (known) return known;
    if (!url.endsWith(".js")) return [];
    const file = path.join(clientDir, url.slice(base.length));
    const resolved = staticSpecifiers(file, readFileSync(file, "utf8")).map((specifier) => {
      if (/^\.{1,2}\//.test(specifier))
        return resolve(path.posix.join(path.posix.dirname(url), specifier), url);
      if (specifier.startsWith("/")) return resolve(specifier, url);
      throw new Error(`${url}: imports "${specifier}", which a browser cannot resolve`);
    });
    imports.set(url, resolved);
    return resolved;
  };

  /** Everything `roots` reach by static imports, roots included; cycles end the walk. */
  const closure = (roots: Iterable<string>): Set<string> => {
    const seen = new Set<string>();
    const queue = [...roots];
    while (queue.length > 0) {
      const url = queue.shift()!;
      if (seen.has(url)) continue;
      seen.add(url);
      queue.push(...staticImports(url));
    }
    return seen;
  };

  return { clientDir, files, resolve, staticImports, closure };
}
type ClientGraph = ReturnType<typeof clientGraph>;

/** Each route's scripts and preloads with its ancestors', as URL paths. */
export function routeUnions(manifest: Manifest, graph: ClientGraph): Map<string, Set<string>> {
  const unions = new Map<string, Set<string>>();
  for (const [id, chain] of ancestry(manifest)) {
    const union = new Set<string>();
    for (const ancestor of chain) {
      const route = manifest.routes[ancestor]!;
      for (const href of [...moduleScripts(route), ...(route.preloads ?? []).map(hrefOf)]) {
        union.add(graph.resolve(href, `route ${ancestor}`));
      }
    }
    unions.set(id, union);
  }
  return unions;
}

/** What is wrong with the build in `dist`; empty when nothing is. */
export async function checkBuild(dist: string, base = "/"): Promise<Array<string>> {
  const problems: Array<string> = [];
  const graph = clientGraph(path.join(dist, "client"), base);
  for (const file of graph.files) {
    if (!file.endsWith(".js")) continue;
    const text = readFileSync(path.join(graph.clientDir, file), "utf8");
    for (const name of SERVER_ONLY)
      if (text.includes(name)) problems.push(`${file} contains server-only ${name}`);
  }
  const manifest = await loadManifest(path.join(dist, "server"));
  for (const [id, union] of routeUnions(manifest, graph)) {
    for (const url of union) {
      for (const imported of graph.staticImports(url)) {
        if (!union.has(imported))
          problems.push(`route ${id}: ${imported} (imported by ${url}) is not preloaded`);
      }
    }
  }
  return problems;
}

const sha256 = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * What the plugin changed besides adding static descendants to preloads, in
 * `dist` against `baseline` (the same source built without it); empty when
 * nothing. Also returns the URLs it added per route.
 */
export async function compareBuilds(
  dist: string,
  baseline: string,
  base = "/",
): Promise<{ problems: Array<string>; added: Map<string, Array<string>> }> {
  const problems: Array<string> = [];
  const graph = clientGraph(path.join(dist, "client"), base);
  const before = clientGraph(path.join(baseline, "client"), base);
  const files = [...graph.files].sort();
  if (files.join("\n") !== [...before.files].sort().join("\n"))
    problems.push("the client builds have different files");
  for (const file of files) {
    if (
      before.files.has(file) &&
      sha256(path.join(graph.clientDir, file)) !== sha256(path.join(before.clientDir, file))
    ) {
      problems.push(`client file ${file} differs`);
    }
  }
  const manifest = await loadManifest(path.join(dist, "server"));
  const old = await loadManifest(path.join(baseline, "server"));
  const ids = Object.keys(manifest.routes).sort();
  if (ids.join("\n") !== Object.keys(old.routes).sort().join("\n"))
    problems.push("the manifests have different routes");
  for (const id of ids) {
    const [now, then] = [manifest.routes[id]!, old.routes[id]];
    for (const key of ["scripts", "css", "children"] as const) {
      if (JSON.stringify(now[key]) !== JSON.stringify(then?.[key]))
        problems.push(`route ${id}: ${key} differ`);
    }
  }
  const added = new Map<string, Array<string>>();
  const unions = routeUnions(manifest, graph);
  for (const [id, oldUnion] of routeUnions(old, before)) {
    const expected = graph.closure(oldUnion);
    const actual = unions.get(id) ?? new Set();
    const extra = [...actual].filter((url) => !expected.has(url));
    const missing = [...expected].filter((url) => !actual.has(url));
    if (extra.length > 0)
      problems.push(
        `route ${id}: preloads beyond the baseline's static closure: ${extra.join(", ")}`,
      );
    if (missing.length > 0)
      problems.push(`route ${id}: static closure not preloaded: ${missing.join(", ")}`);
    added.set(
      id,
      [...actual].filter((url) => !oldUnion.has(url)),
    );
  }
  return { problems, added };
}

async function main(args: Array<string>) {
  const baselineAt = args.indexOf("--baseline");
  const baseline = baselineAt === -1 ? undefined : args[baselineAt + 1];
  if (baselineAt !== -1 && !baseline) throw new Error("--baseline needs a directory");
  const rest =
    baselineAt === -1 ? args : [...args.slice(0, baselineAt), ...args.slice(baselineAt + 2)];
  if (rest.length > 1) throw new Error(`unexpected arguments: ${rest.join(" ")}`);
  const dist = path.resolve(rest[0] ?? "dist");
  const problems = await checkBuild(dist);
  if (baseline) {
    const compared = await compareBuilds(dist, path.resolve(baseline));
    problems.push(...compared.problems);
    for (const [id, urls] of compared.added)
      if (urls.length > 0) console.log(`${id}: +${urls.join(" +")}`);
  }
  if (problems.length > 0) {
    console.error(`Preload check failed for ${dist}:\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`Preload check passed for ${dist}${baseline ? ` against ${baseline}` : ""}.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(
      `Preload check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
