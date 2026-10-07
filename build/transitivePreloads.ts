// Module preloads for every static import a page needs, not just the first
// level. TanStack Start builds each route's preload list from a chunk and its
// direct `imports` (start-plugin-core manifestBuilder `getChunkPreloads`), so
// a chunk two imports deep is found only once its importer has loaded and
// runs: one more round trip before the page can hydrate (`value` and
// `validator` under catalogData and dates, measured at 49–128 ms in
// docs/decisions.md, "Transitive module preloads").
//
// The pair below sits around TanStack's capture hook
// (`tanstack-start:start-manifest-capture-client-build`, generateBundle,
// enforce "post"), in the client build only:
//
//   expand   replaces each chunk's `imports` with its whole static closure;
//   capture  (TanStack) copies the lists into its manifest data;
//   restore  puts Rolldown's own lists back for every later hook.
//
// Nothing else may see the expanded lists. Vite's import analysis reads
// `imports` to write the `__vitePreload` dependency maps into chunk code; had
// it seen them, files would change without a new hash, breaking the
// `immutable` caching of /assets. So the pair checks, and fails the build
// otherwise, that:
//
//   - the capture hook exists and runs after expand and before restore, and
//     Vite's import analysis does not run between them (configResolved);
//   - every chunk's file name and code are unchanged from expand to restore;
//   - every chunk gets its own list back, and each generation's state is
//     dropped once restored, or at the next build's start after a failure.
//
// build/checkPreloads.ts then checks the built manifest against the client
// files on every `npm run build`. Delete this file once TanStack's preloads
// follow static imports themselves.
import { createHash } from "node:crypto";

import type { Plugin, ResolvedConfig, Rolldown } from "vite";

/** TanStack Start's hook that captures the client bundle for its manifest. */
export const CAPTURE_PLUGIN = "tanstack-start:start-manifest-capture-client-build";
/** Vite's build-time import analysis, which writes `imports` into chunk code. */
export const IMPORT_ANALYSIS_PLUGIN = "vite:build-import-analysis";
const EXPAND = "mangadb:transitive-preloads:expand";
const RESTORE = "mangadb:transitive-preloads:restore";

type Bundle = Rolldown.OutputBundle;
type Saved = { imports: Array<string>; code: string };

const chunksOf = (bundle: Bundle) =>
  Object.values(bundle).filter((output): output is Rolldown.OutputChunk => output.type === "chunk");
const fingerprint = (code: string) => createHash("sha256").update(code).digest("hex");

/**
 * Each chunk's static closure: its own imports first, in their order, then
 * their imports breadth-first. Never the chunk itself, even in a cycle. With
 * the direct imports first, TanStack's preload lists start exactly as they do
 * without this pair, and its CSS walk (which follows `imports` recursively)
 * meets every stylesheet in the same order.
 */
export function staticClosures(
  imports: ReadonlyMap<string, ReadonlyArray<string>>,
): Map<string, Array<string>> {
  const closures = new Map<string, Array<string>>();
  for (const [file, direct] of imports) {
    const seen = new Set<string>([file]);
    const order: Array<string> = [];
    const queue = [...direct];
    while (queue.length > 0) {
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      order.push(next);
      queue.push(...(imports.get(next) ?? []));
    }
    closures.set(file, order);
  }
  return closures;
}

/**
 * The order generateBundle hooks run in, as Vite sorts them: hooks marked
 * `order: "pre"`, then unmarked ones, then `order: "post"`, each group in
 * plugin order.
 */
export function generateBundleOrder(plugins: ReadonlyArray<Plugin>): Array<string> {
  const group = (plugin: Plugin) => {
    const hook = plugin.generateBundle;
    const order = typeof hook === "object" && hook !== null ? hook.order : undefined;
    return order === "pre" ? 0 : order === "post" ? 2 : 1;
  };
  return plugins
    .filter((plugin) => plugin.generateBundle !== undefined)
    .map((plugin, index) => ({ name: plugin.name, group: group(plugin), index }))
    .sort((a, b) => a.group - b.group || a.index - b.index)
    .map(({ name }) => name);
}

/** Why the hooks would run in the wrong order, or null when they won't. */
export function orderProblem(order: ReadonlyArray<string>): string | null {
  const expand = order.indexOf(EXPAND);
  const capture = order.indexOf(CAPTURE_PLUGIN);
  const restore = order.indexOf(RESTORE);
  const analysis = order.indexOf(IMPORT_ANALYSIS_PLUGIN);
  if (capture === -1) return `TanStack's ${CAPTURE_PLUGIN} hook is missing`;
  if (expand === -1 || restore === -1) return "the expand or restore hook is missing";
  if (!(expand < capture && capture < restore)) {
    return `${CAPTURE_PLUGIN} must run between expand and restore; the order is ${order.join(", ")}`;
  }
  if (analysis !== -1 && expand < analysis && analysis < restore) {
    return `${IMPORT_ANALYSIS_PLUGIN} runs between expand and restore and would write the expanded lists into chunk code`;
  }
  return null;
}

/**
 * The plugin pair. Put `expand` just before `tanstackStart()` and `restore`
 * just after it in the plugins array; both are "post" plugins with plain
 * hooks, as TanStack's capture is.
 */
export function transitivePreloads(): { expand: Plugin; restore: Plugin } {
  // One build generation at a time: set by expand, consumed by restore.
  let saved: Map<string, Saved> | undefined;
  const fail = (message: string): never => {
    saved = undefined;
    throw new Error(`transitive preloads: ${message}`);
  };
  const client = (environment: { name: string }) => environment.name === "client";

  const expand: Plugin = {
    name: EXPAND,
    enforce: "post",
    apply: "build",
    applyToEnvironment: client,
    configResolved(config: ResolvedConfig) {
      const problem = orderProblem(generateBundleOrder(config.plugins));
      if (problem) fail(problem);
    },
    // Each generation starts clean, also after a build that failed midway.
    buildStart() {
      saved = undefined;
    },
    generateBundle(_options, bundle) {
      if (saved) fail("the previous build's lists were never restored");
      const chunks = chunksOf(bundle);
      const closures = staticClosures(
        new Map(chunks.map((chunk) => [chunk.fileName, chunk.imports])),
      );
      const generation = new Map<string, Saved>();
      for (const chunk of chunks) {
        generation.set(chunk.fileName, { imports: chunk.imports, code: fingerprint(chunk.code) });
        chunk.imports = closures.get(chunk.fileName)!;
      }
      saved = generation;
    },
  };

  const restore: Plugin = {
    name: RESTORE,
    enforce: "post",
    apply: "build",
    applyToEnvironment: client,
    generateBundle(_options, bundle) {
      const generation = saved ?? fail("expand did not run before restore");
      const chunks = chunksOf(bundle);
      if (chunks.length !== generation.size) {
        fail("chunks were added or removed between expand and restore");
      }
      for (const chunk of chunks) {
        const before =
          generation.get(chunk.fileName) ?? fail(`${chunk.fileName} appeared after expand`);
        if (fingerprint(chunk.code) !== before.code) {
          fail(
            `${chunk.fileName} changed between expand and restore; its hash no longer names its content`,
          );
        }
        chunk.imports = before.imports;
        if (chunk.imports.join("\n") !== before.imports.join("\n")) {
          fail(`${chunk.fileName} kept its expanded imports`);
        }
      }
      saved = undefined;
    },
  };

  return { expand, restore };
}
