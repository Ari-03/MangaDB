// Checks the home jacket check's budget and background ownership in a local
// workerd (Miniflare), where request lifetime is enforced as on Cloudflare:
// work a request does not own is cancelled once its response is sent. The
// unit tests (src/server/covers.test.ts) prove the logic under fake timers;
// they cannot prove that. Opt-in, not part of `npm test`: it starts workerd
// and takes about 15 s.
//
// Usage:
//   VITE_CONVEX_URL=https://convex.invalid npm run build
//   node scripts/check-cover-budget.mjs --root "$PWD" --dist "$PWD/dist" [--report out.json]
//
// R2 is a stand-in Worker bound as COVERS through a service binding: its RPC
// head() answers after a delay set per key, so a slow read is real I/O for
// the app's request. That proves lifetimes and promise ownership, not R2's
// latency or connection queueing. Nothing leaves the machine: every outbound
// fetch of both app Workers is answered by this script (the mocked Convex at
// https://convex.invalid) or refused. Clerk runs with a fake key for a host
// that cannot resolve, and every request here is sent with redirect: "manual".
//
// 1. helper: src/server/covers.ts and timing.ts bundled with esbuild into a
//    small Worker. Three reads out at the budget, landing at 450, 1500 and
//    2500 ms: each must still finish, be remembered, and start no refill; a
//    late failure is not remembered; two concurrent requests keep their own
//    head counts. This is the helper alone, not the TanStack server function.
// 2. chain: the compiled app from --dist (built with VITE_CONVEX_URL set to
//    https://convex.invalid, which the script checks). Two home SSRs and the
//    real cover server function, in flight together, report their own
//    Server-Timing (a partial check counting the heads it sent); late reads
//    are remembered for the next SSR; a Clerk handshake keeps its redirect.
//
// Tools come from --root's node_modules (wrangler's miniflare, esbuild,
// workerd, seroval); a missing one is an error, never a skip. Bundles go to
// a fresh directory under TMPDIR, printed and kept. Exit 0 when every check
// holds, 1 otherwise, 2 on bad usage.

import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { root: { type: "string" }, dist: { type: "string" }, report: { type: "string" } },
});
if (!args.root || !path.isAbsolute(args.root) || !args.dist || !path.isAbsolute(args.dist)) {
  console.error("usage: check-cover-budget.mjs --root <absolute checkout> --dist <absolute dist>");
  process.exit(2);
}
const root = args.root;
const dist = args.dist;

const BUDGET_MS = 300;
// Scheduling slack for a loaded machine: timer firing, RPC and dispatch.
const TOLERANCE_MS = Number(process.env.COVER_CHECK_TOLERANCE_MS ?? 700);
const STARTUP_MS = 60_000;
const DISPATCH_MS = 15_000;
const TEARDOWN_MS = 15_000;
// Kills a run that hangs anywhere else.
setTimeout(() => {
  console.error("check-cover-budget: no result within 180 s");
  process.exit(1);
}, 180_000).unref();

const require = createRequire(path.join(root, "package.json"));
/** A tool from the checkout's node_modules, with its version; missing is fatal. */
function tool(name) {
  try {
    return { module: require(name), version: require(`${name}/package.json`).version };
  } catch (error) {
    throw new Error(`${name} is not installed under ${root} (run npm ci there): ${error.message}`);
  }
}
const esbuild = tool("esbuild");
const miniflare = tool("miniflare");
const workerd = tool("workerd");
const seroval = {
  module: await import(pathToFileURL(require.resolve("seroval")).href),
  version: tool("seroval").version,
};
const { Miniflare, convertV4MiniflareOptions } = miniflare.module;

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `work`, or an error naming `label` once `ms` pass first. */
async function bounded(work, ms, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}: nothing within ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const failures = [];
const check = (ok, label, detail) => {
  if (!ok) failures.push({ label, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : ` ${JSON.stringify(detail)}`}`);
};
const metrics = (header) => (header ?? "").split(", ").filter(Boolean);
const spanNames = (header) => metrics(header).map((metric) => metric.split(";")[0]);
const covOutcome = (header) =>
  metrics(header)
    .find((metric) => metric.startsWith("cov;"))
    ?.match(/desc="(\w+)"/)?.[1];
const covr2 = (header) =>
  Number(
    metrics(header)
      .find((metric) => metric.startsWith("covr2;"))
      ?.match(/desc="(\d+)"/)?.[1],
  );

const work = mkdtempSync(path.join(tmpdir(), "cover-budget-"));
const report = {
  at: new Date().toISOString(),
  root,
  dist,
  work,
  sources: Object.fromEntries(
    ["src/server/covers.ts", "src/server/timing.ts", "src/server/edgeCache.ts"].map((file) => [
      file,
      sha256(path.join(root, file)),
    ]),
  ),
  distServerIndex: sha256(path.join(dist, "server/index.js")),
  versions: {
    node: process.version,
    miniflare: miniflare.version,
    esbuild: esbuild.version,
    workerd: workerd.version,
    seroval: seroval.version,
  },
  budgetMs: BUDGET_MS,
  toleranceMs: TOLERANCE_MS,
  phases: {},
};
console.log(`check-cover-budget: root ${root}, bundles in ${work}`);
console.log(JSON.stringify({ sources: report.sources, versions: report.versions }));

// The stand-in R2: head() answers each key per the plan set through its
// fetch handler (`ms` delay, then `on`, `off` or `fail`), and logs when each
// read starts and ends. get() finds nothing and put() keeps nothing.
const STAND_IN_R2 = `import { WorkerEntrypoint } from "cloudflare:workers";
const plan = new Map();
const events = [];
export default class extends WorkerEntrypoint {
  async head(key) {
    const step = plan.get(key) ?? { ms: 0, result: "off" };
    events.push({ key, event: "start", at: Date.now() });
    if (step.ms > 0) await new Promise((resolve) => setTimeout(resolve, step.ms));
    events.push({ key, event: "end", result: step.result, at: Date.now() });
    if (step.result === "fail") throw new Error("stand-in R2 failure");
    return step.result === "on" ? { key } : null;
  }
  async get() {
    return null;
  }
  async put() {
    return null;
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/plan") {
      for (const [key, step] of Object.entries(await request.json())) plan.set(key, step);
      return new Response("ok");
    }
    return Response.json(events);
  }
}
`;
const standIn = { name: "r2", modules: true, script: STAND_IN_R2, compatibilityDate: "2026-08-01" };
/** Start Miniflare with `workers`; the first is the app. */
async function start(workers) {
  const mf = new Miniflare(convertV4MiniflareOptions({ workers }));
  const url = String(await bounded(mf.ready, STARTUP_MS, "workerd startup")).replace(/\/$/, "");
  const r2 = await mf.getWorker("r2");
  return {
    mf,
    url,
    plan: (steps) =>
      r2
        .fetch("http://r2/plan", { method: "POST", body: JSON.stringify(steps) })
        .then((r) => r.text()),
    events: () => r2.fetch("http://r2/events").then((response) => response.json()),
  };
}
/** Wait until `done(events)` holds or `ms` pass; returns the last events seen. */
async function eventsUntil(r2, done, ms) {
  const deadline = Date.now() + ms;
  let events = await r2.events();
  while (!done(events) && Date.now() < deadline) {
    await sleep(100);
    events = await r2.events();
  }
  return events;
}
const ended = (events, key) => events.some((event) => event.key === key && event.event === "end");
const started = (events, key) =>
  events.filter((event) => event.key === key && event.event === "start").length;
const refused = [];
const refuse = async (request) => {
  refused.push(new URL(request.url).origin);
  return new Response("refused by check-cover-budget", { status: 599 });
};

// ---------- 1. helper ----------
{
  const entry = path.join(work, "helper-entry.ts");
  writeFileSync(
    entry,
    `import { coversOnFile } from ${JSON.stringify(path.join(root, "src/server/covers.ts"))};
import { timeRequest } from ${JSON.stringify(path.join(root, "src/server/timing.ts"))};
export default {
  fetch(request: Request) {
    return timeRequest(async () => {
      const shelves = await request.json();
      const started = Date.now();
      const answer = await coversOnFile(shelves, "https://check.invalid");
      return Response.json({ answer, workerMs: Date.now() - started });
    });
  },
};
`,
  );
  await esbuild.module.build({
    entryPoints: [entry],
    outfile: path.join(work, "helper.mjs"),
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    alias: { "~": path.join(root, "src") },
    external: ["cloudflare:workers", "node:*"],
    logLevel: "silent",
  });
  const app = {
    name: "app",
    modules: true,
    modulesRoot: work,
    scriptPath: path.join(work, "helper.mjs"),
    compatibilityDate: "2026-08-01",
    compatibilityFlags: ["nodejs_compat"],
    serviceBindings: { COVERS: "r2" },
    outboundService: refuse,
  };
  const isbn = (n) => `97819740${String(n).padStart(5, "0")}`;
  const key = (n) => `${isbn(n)}.jpg`;
  const { mf, plan, events } = await start([app, standIn]);
  const r2 = { events };
  try {
    const ask = async (shelves) => {
      const sent = performance.now();
      const response = await bounded(
        mf.dispatchFetch("http://app.local/", { method: "POST", body: JSON.stringify(shelves) }),
        DISPATCH_MS,
        "helper request",
      );
      const body = await response.json();
      return {
        ...body,
        nodeMs: Math.round(performance.now() - sent),
        timing: response.headers.get("Server-Timing"),
      };
    };
    const atBudget = (result) =>
      result.workerMs >= BUDGET_MS - 5 && result.nodeMs < BUDGET_MS + TOLERANCE_MS;
    const phase = {};

    // Three reads out at the budget; the fourth candidate is never read.
    await plan({
      [key(1)]: { ms: 450, result: "on" },
      [key(2)]: { ms: 1500, result: "off" },
      [key(3)]: { ms: 2500, result: "on" },
      [key(4)]: { ms: 0, result: "on" },
    });
    const shelf = [{ need: 3, candidates: [isbn(1), isbn(2), isbn(3), isbn(4)] }];
    phase.first = await ask(shelf);
    check(atBudget(phase.first), "late reads: answered at the budget", phase.first);
    check(
      JSON.stringify(phase.first.answer) === JSON.stringify([isbn(1), isbn(2), isbn(3)]),
      "late reads: all three unknown, seated in order",
      phase.first.answer,
    );
    check(
      covOutcome(phase.first.timing) === "partial" && covr2(phase.first.timing) === 3,
      "late reads: cov partial, covr2 3",
      phase.first.timing,
    );
    phase.events = await eventsUntil(
      r2,
      (seen) => [1, 2, 3].every((n) => ended(seen, key(n))),
      4_000,
    );
    for (const [n, ms] of [
      [1, 450],
      [2, 1500],
      [3, 2500],
    ]) {
      check(
        ended(phase.events, key(n)),
        `late reads: the ${ms} ms read finished after the response`,
      );
    }
    check(started(phase.events, key(4)) === 0, "late reads: no refill read after the budget");
    phase.second = await ask(shelf);
    check(
      JSON.stringify(phase.second.answer) === JSON.stringify([isbn(1), isbn(3), isbn(4)]),
      "late reads: the next request seats what they learned (2 absent)",
      phase.second.answer,
    );
    check(
      covOutcome(phase.second.timing) === "complete" && covr2(phase.second.timing) === 1,
      "late reads: the next request reads only the refill (covr2 1)",
      phase.second.timing,
    );
    const afterSecond = await r2.events();
    check(
      [1, 2, 3, 4].every((n) => started(afterSecond, key(n)) === 1),
      "late reads: each ISBN was read once across both requests",
      afterSecond,
    );

    // A failure after the budget is logged and not remembered.
    await plan({ [key(10)]: { ms: 600, result: "fail" } });
    const failing = [{ need: 1, candidates: [isbn(10)] }];
    phase.failFirst = await ask(failing);
    await eventsUntil(r2, (seen) => ended(seen, key(10)), 2_000);
    phase.failSecond = await ask(failing);
    check(
      covr2(phase.failFirst.timing) === 1 && covr2(phase.failSecond.timing) === 1,
      "late failure: asked again by the next request",
      [phase.failFirst.timing, phase.failSecond.timing],
    );
    check(
      JSON.stringify(phase.failSecond.answer) === JSON.stringify([isbn(10)]) &&
        atBudget(phase.failSecond),
      "late failure: still unknown and bounded next time",
      phase.failSecond,
    );

    // Two requests at once in one isolate keep their own counts; an ISBN on
    // two shelves is one head.
    await plan({
      [key(20)]: { ms: 800, result: "on" },
      [key(21)]: { ms: 800, result: "on" },
      [key(22)]: { ms: 0, result: "on" },
    });
    const [slow, quick] = await Promise.all([
      ask([{ need: 2, candidates: [isbn(20), isbn(21)] }]),
      ask([
        { need: 1, candidates: [isbn(22)] },
        { need: 1, candidates: [isbn(22)] },
      ]),
    ]);
    phase.concurrent = { slow, quick };
    check(
      covOutcome(slow.timing) === "partial" && covr2(slow.timing) === 2,
      "concurrent: the slow request is partial with its 2 heads",
      slow.timing,
    );
    check(
      covOutcome(quick.timing) === "complete" && covr2(quick.timing) === 1,
      "concurrent: the quick one is complete with its 1 head",
      quick.timing,
    );
    await eventsUntil(r2, (seen) => ended(seen, key(20)) && ended(seen, key(21)), 2_000);
    report.phases.helper = phase;
  } finally {
    await bounded(mf.dispose(), TEARDOWN_MS, "workerd teardown (helper)");
  }
}

// ---------- 2. chain: the compiled app ----------
{
  const CONVEX = "https://convex.invalid";
  const serverFiles = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name);
      if (statSync(file).isDirectory()) walk(file);
      else if (file.endsWith(".js")) serverFiles.push(file);
    }
  };
  walk(path.join(dist, "server"));
  if (!serverFiles.some((file) => readFileSync(file, "utf8").includes(CONVEX))) {
    throw new Error(`${dist} was not built with VITE_CONVEX_URL=${CONVEX}`);
  }
  // The cover server function's id, from Start's resolver, by its name.
  const ids = serverFiles.flatMap((file) => [
    ...readFileSync(file, "utf8").matchAll(
      /"([0-9a-f]{64})":\s*\{\s*functionName:\s*"fetchCoversOnFile_createServerFn_handler"/g,
    ),
  ]);
  if (ids.length !== 1) throw new Error(`expected one fetchCoversOnFile id, found ${ids.length}`);
  const rpcPath = `/_serverFn/${ids[0][1]}`;
  const entry = path.join(dist, "server/index.js");
  const config = JSON.parse(readFileSync(path.join(dist, "server/wrangler.json"), "utf8"));
  const PK = `pk_test_${Buffer.from("clerk.example.invalid$").toString("base64")}`;

  const isbn = (prefix, n) => `97810${prefix}${String(n).padStart(7, "0")}`;
  const key = (prefix, n) => `${isbn(prefix, n)}.jpg`;
  const title = (prefix, n) => `Chain-${prefix}-${n}-title`;
  const catalog = (prefix, count) => ({
    "catalog:stats": { series: { count }, volumes: { count: 1 }, publishers: { count: 1 } },
    "catalog:recentSeries": Array.from({ length: count }, (_, i) => ({
      publicId: 9000 - i,
      title: title(prefix, i + 1),
      coverUrl: null,
      coverIsbns: [isbn(prefix, i + 1)],
    })),
    "releases:monthBrowse": { releases: [] },
  });
  const catalogs = { first: catalog("2", 6), second: catalog("3", 5) };
  const queue = [];
  let onArrival = () => {};
  const app = {
    name: "app",
    modules: [entry, ...serverFiles.filter((file) => file !== entry)].map((file) => ({
      type: "ESModule",
      path: file,
    })),
    modulesRoot: path.join(dist, "server"),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    bindings: {
      CANONICAL_HOST: "",
      VITE_CONVEX_URL: CONVEX,
      VITE_PUBLIC_POSTHOG_KEY: "",
      CLERK_SECRET_KEY: "sk_test_fake",
      CLERK_PUBLISHABLE_KEY: PK,
      VITE_CLERK_PUBLISHABLE_KEY: PK,
      CLERK_TELEMETRY_DISABLED: "1",
    },
    serviceBindings: { COVERS: "r2" },
    // Convex reads queue here until the script answers them; all else is refused.
    outboundService: async (request) => {
      if (new URL(request.url).origin !== CONVEX) return refuse(request);
      const { path: query } = await request.json();
      const answered = new Promise((resolve) => queue.push({ query, resolve }));
      onArrival();
      return answered;
    },
  };
  const convexAnswer = (value) =>
    new Response(JSON.stringify({ status: "success", value, logLines: [] }), {
      headers: { "Content-Type": "application/json" },
    });
  const arrived = (n) =>
    bounded(
      new Promise((resolve) => {
        onArrival = () => queue.length >= n && resolve();
        onArrival();
      }),
      DISPATCH_MS,
      `${n} Convex reads`,
    );

  const { mf, url, plan, events } = await start([app, standIn]);
  const r2 = { events };
  try {
    // Accept */*, as curl sends: Clerk's development instance answers a
    // text/html request without its dev-browser cookie with a handshake.
    const ssr = () =>
      bounded(
        fetch(`${url}/`, { headers: { Accept: "*/*" }, redirect: "manual" }).then(
          async (response) => ({
            status: response.status,
            timing: response.headers.get("Server-Timing"),
            setCookies: response.headers.getSetCookie().length,
            html: await response.text(),
          }),
        ),
        DISPATCH_MS,
        "home SSR",
      );
    const rpc = (shelves) =>
      bounded(
        (async () => {
          const body = JSON.stringify(await seroval.module.toJSONAsync({ data: shelves }));
          const response = await fetch(`${url}${rpcPath}`, {
            method: "POST",
            headers: {
              "x-tsr-serverFn": "true",
              "content-type": "application/json",
              accept: "application/json",
            },
            body,
            redirect: "manual",
          });
          const text = await response.text();
          let answer;
          try {
            // Start answers { result, context }.
            answer = seroval.module.fromCrossJSON(JSON.parse(text), { refs: new Map() }).result;
          } catch {
            answer = text.slice(0, 200);
          }
          return { status: response.status, timing: response.headers.get("Server-Timing"), answer };
        })(),
        DISPATCH_MS,
        "cover server function",
      );
    const phase = { rpcPath };
    // First SSR: six Series; three reads land after the budget, one absent.
    await plan({
      [key("2", 1)]: { ms: 0, result: "on" },
      [key("2", 2)]: { ms: 450, result: "on" },
      [key("2", 3)]: { ms: 1500, result: "off" },
      [key("2", 4)]: { ms: 2500, result: "on" },
      [key("2", 5)]: { ms: 0, result: "off" },
      [key("2", 6)]: { ms: 0, result: "on" },
      // Second SSR: all on file at once.
      ...Object.fromEntries([1, 2, 3, 4, 5].map((n) => [key("3", n), { ms: 0, result: "on" }])),
      // The server function: one read fails after the budget, one is on file.
      [key("4", 1)]: { ms: 600, result: "fail" },
      [key("4", 2)]: { ms: 0, result: "on" },
    });
    const rpcShelves = [{ need: 2, candidates: [isbn("4", 1), isbn("4", 2)] }];
    const first = ssr();
    await arrived(4);
    const second = ssr();
    await arrived(8);
    const call = rpc(rpcShelves);
    for (const [index, item] of queue.entries()) {
      item.resolve(convexAnswer((index < 4 ? catalogs.first : catalogs.second)[item.query]));
    }
    const [a, b, c] = await Promise.all([first, second, call]);
    phase.concurrent = {
      ssr1: { status: a.status, timing: a.timing, setCookies: a.setCookies },
      ssr2: { status: b.status, timing: b.timing, setCookies: b.setCookies },
      rpc: c,
    };
    const ssrSpans = JSON.stringify(["auth", "cat", "cov", "covr2", "app"]);
    check(a.status === 200 && b.status === 200, "SSRs 200", [a.status, b.status]);
    check(
      JSON.stringify(spanNames(a.timing)) === ssrSpans &&
        JSON.stringify(spanNames(b.timing)) === ssrSpans,
      "SSRs: auth, cat, cov, covr2, app",
      [a.timing, b.timing],
    );
    check(
      covOutcome(a.timing) === "partial" && covr2(a.timing) === 6,
      "SSR 1: partial, its own 6 heads",
      a.timing,
    );
    check(
      covOutcome(b.timing) === "complete" && covr2(b.timing) === 5,
      "SSR 2: complete, its own 5 heads",
      b.timing,
    );
    const seated = (html, prefix, n) => html.includes(title(prefix, n));
    check(
      [1, 2, 3, 4, 6].every((n) => seated(a.html, "2", n)) && !seated(a.html, "2", 5),
      "SSR 1: unknowns seated, the absent Series off",
      [1, 2, 3, 4, 5, 6].map((n) => seated(a.html, "2", n)),
    );
    check(a.html.trimEnd().endsWith("</html>"), "SSR 1: the whole document arrived");
    check(
      JSON.stringify(spanNames(c.timing)) === JSON.stringify(["auth", "cov", "covr2", "app"]),
      "server function: auth, cov, covr2, app (no cat)",
      c.timing,
    );
    check(
      c.status === 200 && covOutcome(c.timing) === "partial" && covr2(c.timing) === 2,
      "server function: partial, its own 2 heads",
      c,
    );
    check(
      JSON.stringify(c.answer) === JSON.stringify([isbn("4", 1), isbn("4", 2)]),
      "server function: the unknown read keeps its seat",
      c.answer,
    );

    phase.events = await eventsUntil(
      r2,
      (seen) => [2, 3, 4].every((n) => ended(seen, key("2", n))) && ended(seen, key("4", 1)),
      4_000,
    );
    check(
      [2, 3, 4].every((n) => ended(phase.events, key("2", n))),
      "SSR 1: its reads at 450, 1500 and 2500 ms finished after the response",
    );
    // A third SSR in the same isolate: everything is remembered.
    const third = ssr();
    await arrived(12);
    for (const item of queue.slice(8)) item.resolve(convexAnswer(catalogs.first[item.query]));
    const t = await third;
    phase.third = { status: t.status, timing: t.timing };
    check(
      covOutcome(t.timing) === "complete" && covr2(t.timing) === 0,
      "next SSR: complete from the memo, 0 heads",
      t.timing,
    );
    check(
      [1, 2, 4, 6].every((n) => seated(t.html, "2", n)) && !seated(t.html, "2", 3),
      "next SSR: the late absence keeps its Series off",
      [1, 2, 3, 4, 5, 6].map((n) => seated(t.html, "2", n)),
    );
    const again = await rpc(rpcShelves);
    phase.repeatRpc = again;
    check(
      covr2(again.timing) === 1 && covOutcome(again.timing) === "partial",
      "server function again: the late failure is asked again, the jacket on file is not",
      again.timing,
    );
    // A browser document request: Clerk's handshake short-circuits the chain.
    const handshake = await bounded(
      fetch(`${url}/`, {
        headers: { Accept: "text/html", "Sec-Fetch-Dest": "document" },
        redirect: "manual",
      }),
      DISPATCH_MS,
      "handshake",
    );
    await handshake.text();
    phase.handshake = {
      status: handshake.status,
      location: (handshake.headers.get("Location") ?? "").split("?")[0],
      timing: handshake.headers.get("Server-Timing"),
      setCookies: handshake.headers.getSetCookie().length,
    };
    check(
      handshake.status === 307 &&
        phase.handshake.location.startsWith("https://clerk.example.invalid/"),
      "handshake keeps its 307 and Location",
      phase.handshake,
    );
    check(
      JSON.stringify(spanNames(phase.handshake.timing)) === JSON.stringify(["app"]),
      "handshake: app only",
      phase.handshake.timing,
    );
    check(phase.handshake.setCookies > 0, "handshake keeps Clerk's Set-Cookie", phase.handshake);
    report.phases.chain = phase;
  } finally {
    await bounded(mf.dispose(), TEARDOWN_MS, "workerd teardown (chain)");
  }
}

// Absent jackets are warmed in the background; their upstream lookups are refused here.
const UPSTREAMS = ["https://images.penguinrandomhouse.com", "https://covers.openlibrary.org"];
report.refusedOutbound = refused;
check(
  refused.every((origin) => UPSTREAMS.includes(origin)),
  "no outbound request but refused cover warm-ups",
  refused,
);
report.failures = failures;
if (args.report) writeFileSync(args.report, `${JSON.stringify(report, null, 2)}\n`);
console.log(failures.length === 0 ? "PASS" : `FAILED ${failures.length}`);
process.exit(failures.length === 0 ? 0 : 1);
