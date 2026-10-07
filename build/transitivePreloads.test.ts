import type { Plugin, ResolvedConfig, Rolldown } from "vite";
import { describe, expect, test } from "vitest";

import {
  CAPTURE_PLUGIN,
  generateBundleOrder,
  IMPORT_ANALYSIS_PLUGIN,
  orderProblem,
  staticClosures,
  transitivePreloads,
} from "./transitivePreloads";

type FakeChunk = { type: "chunk"; fileName: string; imports: Array<string>; code: string };

/** A bundle of chunks with these imports; only the fields the pair reads. */
function bundleOf(imports: Record<string, Array<string>>): Rolldown.OutputBundle {
  const chunks: Record<string, FakeChunk> = {};
  for (const [fileName, list] of Object.entries(imports)) {
    chunks[fileName] = { type: "chunk", fileName, imports: list, code: `// ${fileName}` };
  }
  // The pair reads type, fileName, imports and code; the rest of OutputChunk is unused.
  return chunks as unknown as Rolldown.OutputBundle;
}
const chunk = (bundle: Rolldown.OutputBundle, name: string) => bundle[name] as unknown as FakeChunk;

/** Run a plugin's generateBundle hook the way the bundler does. */
function generate(plugin: Plugin, bundle: Rolldown.OutputBundle) {
  const hook = plugin.generateBundle;
  if (typeof hook !== "function") throw new Error(`${plugin.name} has no generateBundle function`);
  return Reflect.apply(hook, {}, [{}, bundle, false]);
}
function startBuild(plugin: Plugin) {
  const hook = plugin.buildStart;
  if (typeof hook !== "function") throw new Error(`${plugin.name} has no buildStart function`);
  return Reflect.apply(hook, {}, [{}]);
}

describe("staticClosures", () => {
  test("lists direct imports first, in order, then deeper ones breadth-first", () => {
    const closures = staticClosures(
      new Map([
        ["entry.js", ["a.js", "b.js"]],
        ["a.js", ["c.js"]],
        ["b.js", ["d.js", "a.js"]],
        ["c.js", ["e.js"]],
        ["d.js", []],
        ["e.js", []],
      ]),
    );
    expect(closures.get("entry.js")).toEqual(["a.js", "b.js", "c.js", "d.js", "e.js"]);
    expect(closures.get("d.js")).toEqual([]);
  });

  test("never lists a chunk in its own closure, even in a cycle", () => {
    const closures = staticClosures(
      new Map([
        ["a.js", ["b.js"]],
        ["b.js", ["c.js"]],
        ["c.js", ["a.js"]],
      ]),
    );
    expect(closures.get("a.js")).toEqual(["b.js", "c.js"]);
    expect(closures.get("c.js")).toEqual(["a.js", "b.js"]);
  });
});

describe("hook order", () => {
  const plugin = (name: string, order?: "pre" | "post"): Plugin => ({
    name,
    generateBundle: order ? { order, handler() {} } : () => {},
  });
  const { expand, restore } = transitivePreloads();

  test("sorts generateBundle hooks as Vite does: pre, unmarked, post", () => {
    const order = generateBundleOrder([
      plugin("late", "post"),
      expand,
      plugin(CAPTURE_PLUGIN),
      { name: "no-hook" },
      plugin("early", "pre"),
      restore,
    ]);
    expect(order).toEqual(["early", expand.name, CAPTURE_PLUGIN, restore.name, "late"]);
  });

  test("accepts capture between expand and restore, with import analysis after", () => {
    expect(
      orderProblem([expand.name, CAPTURE_PLUGIN, restore.name, IMPORT_ANALYSIS_PLUGIN]),
    ).toBeNull();
  });

  test("refuses a missing capture hook, a reordered one, and import analysis in between", () => {
    expect(orderProblem([expand.name, restore.name])).toMatch(/missing/);
    expect(orderProblem([CAPTURE_PLUGIN, expand.name, restore.name])).toMatch(/between/);
    expect(orderProblem([expand.name, restore.name, CAPTURE_PLUGIN])).toMatch(/between/);
    expect(
      orderProblem([expand.name, IMPORT_ANALYSIS_PLUGIN, CAPTURE_PLUGIN, restore.name]),
    ).toMatch(/import-analysis/);
  });

  test("fails the build at config time when the order is wrong", () => {
    const pair = transitivePreloads();
    const config = { plugins: [plugin(CAPTURE_PLUGIN), pair.expand, pair.restore] };
    const hook = pair.expand.configResolved;
    if (typeof hook !== "function") throw new Error("expand has no configResolved function");
    // configResolved reads only `plugins`.
    expect(() => Reflect.apply(hook, {}, [config as unknown as ResolvedConfig])).toThrow(
      /between expand and restore/,
    );
  });
});

describe("transitivePreloads", () => {
  test("shows capture the closures and gives every later hook the original lists", () => {
    const { expand, restore } = transitivePreloads();
    const bundle = bundleOf({ "entry.js": ["a.js"], "a.js": ["b.js"], "b.js": [] });
    const original = chunk(bundle, "entry.js").imports;
    generate(expand, bundle);
    // What TanStack's capture hook reads:
    expect(chunk(bundle, "entry.js").imports).toEqual(["a.js", "b.js"]);
    expect(chunk(bundle, "a.js").imports).toEqual(["b.js"]);
    generate(restore, bundle);
    expect(chunk(bundle, "entry.js").imports).toBe(original);
    expect(chunk(bundle, "entry.js").imports).toEqual(["a.js"]);
  });

  test("starts each watch rebuild clean, with that generation's file names", () => {
    const { expand, restore } = transitivePreloads();
    const first = bundleOf({ "entry-1.js": ["a-1.js"], "a-1.js": ["b-1.js"], "b-1.js": [] });
    generate(expand, first);
    generate(restore, first);
    startBuild(expand);
    const second = bundleOf({ "entry-2.js": ["a-2.js"], "a-2.js": ["b-2.js"], "b-2.js": [] });
    generate(expand, second);
    expect(chunk(second, "entry-2.js").imports).toEqual(["a-2.js", "b-2.js"]);
    generate(restore, second);
    expect(chunk(second, "entry-2.js").imports).toEqual(["a-2.js"]);
  });

  test("fails when a chunk's code changes between expand and restore", () => {
    const { expand, restore } = transitivePreloads();
    const bundle = bundleOf({ "entry.js": ["a.js"], "a.js": [] });
    generate(expand, bundle);
    chunk(bundle, "entry.js").code += "\n// rewritten";
    expect(() => generate(restore, bundle)).toThrow(/entry\.js changed/);
  });

  test("fails when chunks appear between expand and restore", () => {
    const { expand, restore } = transitivePreloads();
    const bundle = bundleOf({ "entry.js": [] });
    generate(expand, bundle);
    const grown = bundleOf({ "entry.js": [], "late.js": [] });
    expect(() => generate(restore, grown)).toThrow(/added or removed/);
  });

  test("fails when restore runs without expand, or expand twice without restore", () => {
    const pair = transitivePreloads();
    expect(() => generate(pair.restore, bundleOf({ "entry.js": [] }))).toThrow(/did not run/);
    generate(pair.expand, bundleOf({ "entry.js": [] }));
    expect(() => generate(pair.expand, bundleOf({ "entry.js": [] }))).toThrow(/never restored/);
  });

  test("drops a failed generation's state at the next build start", () => {
    const { expand, restore } = transitivePreloads();
    generate(expand, bundleOf({ "entry.js": [] }));
    startBuild(expand);
    const next = bundleOf({ "entry-2.js": [] });
    generate(expand, next);
    expect(() => generate(restore, next)).not.toThrow();
  });

  test("applies to the client build only", () => {
    const { expand, restore } = transitivePreloads();
    for (const plugin of [expand, restore]) {
      const applies = plugin.applyToEnvironment;
      if (typeof applies !== "function") throw new Error("expected applyToEnvironment");
      // applyToEnvironment reads only `name`.
      const env = (name: string) => ({ name }) as unknown as Parameters<typeof applies>[0];
      expect(applies(env("client"))).toBe(true);
      expect(applies(env("ssr"))).toBe(false);
      expect(plugin.apply).toBe("build");
      expect(plugin.enforce).toBe("post");
    }
  });
});
