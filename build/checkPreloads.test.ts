import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { checkBuild, compareBuilds, loadManifest, staticSpecifiers } from "./checkPreloads";

// Small builds on disk: dist/client files and a dist/server manifest module.
const made: Array<string> = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

type Routes = Record<string, Record<string, unknown>>;
const manifestModule = (routes: Routes) =>
  `var tsrStartManifest = () => (${JSON.stringify({ routes })});\nexport { tsrStartManifest };\n`;

/** A dist directory with `client` files and, unless `server` is given, one manifest of `routes`. */
function build(client: Record<string, string>, routes: Routes, server?: Record<string, string>) {
  const dist = mkdtempSync(path.join(tmpdir(), "check-preloads-"));
  made.push(dist);
  const files = {
    ...Object.fromEntries(Object.entries(client).map(([file, text]) => [`client/${file}`, text])),
    ...Object.fromEntries(
      Object.entries(
        server ?? { "assets/_tanstack-start-manifest_v-x.js": manifestModule(routes) },
      ).map(([file, text]) => [`server/${file}`, text]),
    ),
  };
  if (!Object.keys(files).some((file) => file.startsWith("client/"))) files["client/.keep"] = "";
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dist, file)), { recursive: true });
    writeFileSync(path.join(dist, file), text);
  }
  return dist;
}

const root = (preloads: Array<string>, children?: Array<string>) => ({
  children,
  preloads,
  scripts: [{ attrs: { type: "module", async: true, src: "/assets/entry.js" } }],
});

// entry → shared → deep; a nested layout and page; a lazy chunk only import()ed.
const CLIENT = {
  "assets/entry.js": 'import "./shared.js";\nconst lazy = () => import("./lazy.js");\n',
  "assets/shared.js": 'export * from "./deep.js";\n',
  "assets/deep.js": "export const deep = 1;\n",
  "assets/lazy.js": "export const lazy = 1;\n",
  "assets/layout.js": 'import { deep } from "./deep.js";\nexport { deep };\n',
  "assets/page.js": 'import { x } from "./sub/x.js";\nexport { x };\n',
  "assets/sub/x.js":
    'import { util } from "../util.js";\nimport "./util.js";\nexport const x = util;\n',
  "assets/util.js": "export const util = 1;\n",
  "assets/sub/util.js": "export const sideEffect = 1;\n",
  "assets/styles.css": "body {}\n",
};
const COMPLETE: Routes = {
  __root__: root(
    ["/assets/entry.js", "/assets/shared.js", "/assets/deep.js"],
    ["/_layout", "/about"],
  ),
  // A pathless layout whose page inherits the root's and the layout's preloads.
  "/_layout": { children: ["/_layout/page"], preloads: ["/assets/layout.js"] },
  "/_layout/page": {
    preloads: ["/assets/page.js", "/assets/sub/x.js", "/assets/util.js", "/assets/sub/util.js"],
  },
};

describe("staticSpecifiers", () => {
  test("finds imports, side-effect imports and re-exports, never import()", () => {
    expect(
      staticSpecifiers(
        "a.js",
        'import a from "./a.js";\nimport "./side.js";\nexport * from "./all.js";\nexport { b } from "./b.js";\nimport("./lazy.js");\nexport const c = 1;\n',
      ),
    ).toEqual(["./a.js", "./side.js", "./all.js", "./b.js"]);
  });
});

describe("checkBuild", () => {
  test("passes a build whose routes preload every static import, with ancestors' preloads inherited", async () => {
    expect(await checkBuild(build(CLIENT, COMPLETE))).toEqual([]);
  });

  test("reports each static descendant a route does not preload, with its importer", async () => {
    const routes = {
      ...COMPLETE,
      __root__: root(["/assets/entry.js", "/assets/shared.js"], ["/_layout", "/about"]),
    };
    const problems = await checkBuild(build(CLIENT, routes));
    expect(problems).toContain(
      "route __root__: /assets/deep.js (imported by /assets/shared.js) is not preloaded",
    );
    expect(problems.filter((problem) => problem.startsWith("route /_layout/page:"))).toEqual([
      "route /_layout/page: /assets/deep.js (imported by /assets/shared.js) is not preloaded",
      "route /_layout/page: /assets/deep.js (imported by /assets/layout.js) is not preloaded",
    ]);
  });

  test("resolves ../ and subdirectories by URL, so same-named files stay apart", async () => {
    const routes = {
      ...COMPLETE,
      "/_layout/page": { preloads: ["/assets/page.js", "/assets/sub/x.js", "/assets/util.js"] },
    };
    expect(await checkBuild(build(CLIENT, routes))).toEqual([
      "route /_layout/page: /assets/sub/util.js (imported by /assets/sub/x.js) is not preloaded",
    ]);
  });

  test("ends its walk on import cycles", async () => {
    const client = {
      "assets/entry.js": 'import "./a.js";\n',
      "assets/a.js": 'import "./b.js";\n',
      "assets/b.js": 'import "./a.js";\nimport "./entry.js";\n',
    };
    const routes = { __root__: root(["/assets/entry.js", "/assets/a.js", "/assets/b.js"]) };
    expect(await checkBuild(build(client, routes))).toEqual([]);
  });

  test("fails on an import that names no file, or a bare one", async () => {
    const missing = { ...CLIENT, "assets/deep.js": 'import "./gone.js";\n' };
    await expect(checkBuild(build(missing, COMPLETE))).rejects.toThrow(
      "/assets/deep.js: /assets/gone.js names no file in the client build",
    );
    const bare = { ...CLIENT, "assets/deep.js": 'import "react";\n' };
    await expect(checkBuild(build(bare, COMPLETE))).rejects.toThrow(/"react", which a browser/);
  });

  test("fails on a preload outside the client build or on another host", async () => {
    const outside = { ...COMPLETE, "/about": { preloads: ["/assets/../../server/index.js"] } };
    await expect(checkBuild(build(CLIENT, outside))).rejects.toThrow(/names no file|outside base/);
    const external = { ...COMPLETE, "/about": { preloads: ["https://cdn.example/x.js"] } };
    await expect(checkBuild(build(CLIENT, external))).rejects.toThrow(/not a local URL/);
  });

  test("fails on a route no chain of children reaches", async () => {
    // "/_layout" lists the page, but the layout itself is left out of the manifest.
    const { "/_layout": _layout, ...orphaned } = COMPLETE;
    await expect(checkBuild(build(CLIENT, orphaned))).rejects.toThrow(
      /not reachable from __root__.*\/_layout\/page/,
    );
  });

  test("reports server-only modules in client files", async () => {
    const leaked = {
      ...CLIENT,
      "assets/deep.js": 'const x = "node:async_hooks";\nexport const deep = x;\n',
    };
    expect(await checkBuild(build(leaked, COMPLETE))).toEqual([
      "assets/deep.js contains server-only node:async_hooks",
    ]);
  });
});

describe("loadManifest", () => {
  const serverOnly = (server: Record<string, string>) =>
    loadManifest(path.join(build(CLIENT, COMPLETE, server), "server"));

  test("needs exactly one module exporting tsrStartManifest", async () => {
    await expect(serverOnly({ "index.js": "export default {};\n" })).rejects.toThrow(/found 0/);
    await expect(
      serverOnly({
        "assets/one.js": manifestModule(COMPLETE),
        "assets/two.js": manifestModule(COMPLETE),
      }),
    ).rejects.toThrow(/found 2/);
  });

  test("refuses a manifest that is not a function, empty, or malformed", async () => {
    await expect(serverOnly({ "m.js": "export const tsrStartManifest = 1;\n" })).rejects.toThrow(
      /not a function/,
    );
    await expect(serverOnly({ "m.js": manifestModule({}) })).rejects.toThrow(/no routes/);
    await expect(
      serverOnly({ "m.js": manifestModule({ __root__: root([]), "/x": { preloads: [7] } }) }),
    ).rejects.toThrow(/malformed preloads/);
    await expect(
      serverOnly({ "m.js": manifestModule({ __root__: { preloads: ["/assets/entry.js"] } }) }),
    ).rejects.toThrow(/no module script/);
  });

  test("reads link objects as well as strings", async () => {
    const routes = {
      ...COMPLETE,
      __root__: {
        ...root(["/assets/entry.js", "/assets/shared.js"], ["/_layout"]),
        preloads: ["/assets/entry.js", { href: "/assets/shared.js" }, { href: "/assets/deep.js" }],
      },
    };
    expect(await checkBuild(build(CLIENT, routes))).toEqual([]);
  });
});

describe("compareBuilds", () => {
  // What TanStack makes without the plugin: each chunk and its direct imports.
  const DIRECT: Routes = {
    ...COMPLETE,
    __root__: root(["/assets/entry.js", "/assets/shared.js"], ["/_layout", "/about"]),
    "/_layout/page": { preloads: ["/assets/page.js", "/assets/sub/x.js"] },
  };
  const baseline = build(CLIENT, DIRECT);

  test("accepts preloads that add exactly the static closure", async () => {
    const { problems, added } = await compareBuilds(build(CLIENT, COMPLETE), baseline);
    expect(problems).toEqual([]);
    expect(added.get("__root__")).toEqual(["/assets/deep.js"]);
    expect(added.get("/_layout/page")).toEqual([
      "/assets/deep.js",
      "/assets/util.js",
      "/assets/sub/util.js",
    ]);
  });

  test("reports a preload beyond the closure, such as an import()ed chunk", async () => {
    const broad = {
      ...COMPLETE,
      __root__: root(
        [...(COMPLETE.__root__!.preloads as Array<string>), "/assets/lazy.js"],
        ["/_layout", "/about"],
      ),
    };
    const { problems } = await compareBuilds(build(CLIENT, broad), baseline);
    expect(problems).toContain(
      "route __root__: preloads beyond the baseline's static closure: /assets/lazy.js",
    );
  });

  test("reports changed client files, stylesheets and scripts", async () => {
    const changed = { ...CLIENT, "assets/deep.js": "export const deep = 2;\n" };
    const styled = {
      ...COMPLETE,
      "/_layout": { ...COMPLETE["/_layout"], css: [{ href: "/assets/styles.css" }] },
    };
    expect((await compareBuilds(build(changed, COMPLETE), baseline)).problems).toContain(
      "client file assets/deep.js differs",
    );
    expect((await compareBuilds(build(CLIENT, styled), baseline)).problems).toContain(
      "route /_layout: css differ",
    );
  });
});
