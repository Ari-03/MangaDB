// Stops a deploy whose two halves point at different environments, such as a
// production Convex deploy key saved in the staging GitHub environment. It runs
// inside `convex deploy --cmd` right after the Worker build, so a failure here
// stops the deploy before Convex or Cloudflare receive anything. Called by the
// `deploy` scripts in package.json and by .github/workflows/deploy.yml.
//
// Usage: node scripts/check-deploy-target.mjs <production|staging>
//
// It checks the built Worker config against the target:
// - the Wrangler environment and Worker name match the argument,
// - a staging build carries no routes, so it cannot take mangadb.org,
// - the Convex URL in the Worker's vars equals VITE_CONVEX_URL, which
//   `convex deploy` sets to the URL of the deployment its credentials select,
// - the Clerk key in the Worker's vars equals VITE_CLERK_PUBLISHABLE_KEY, the
//   value Vite inlines into the client bundle, when the build has one.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Print every problem, say that nothing was deployed, and exit 1. */
function fail(problems) {
  for (const problem of problems) console.error(`check-deploy-target: ${problem}`);
  console.error("check-deploy-target: nothing was deployed.");
  process.exit(1);
}

/** Parse a JSON file the build wrote, or fail with a hint to build first. */
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    fail([`cannot read ${path} (${error.code ?? error.message}). Run the build first.`]);
  }
}

// The Worker each target must build.
const workerNames = { production: "mangadb", staging: "mangadb-staging" };

const target = process.argv[2];
if (!Object.hasOwn(workerNames, target)) {
  fail([
    `expected "production" or "staging" as the argument, got ${JSON.stringify(target ?? null)}.`,
  ]);
}

// The Cloudflare Vite plugin writes this pointer to the flattened config
// (dist/server/wrangler.json) that `wrangler deploy` will upload.
const pointerPath = resolve(root, ".wrangler/deploy/config.json");
const pointer = readJson(pointerPath);
if (typeof pointer.configPath !== "string") {
  fail([`${pointerPath} has no configPath. Run the build first.`]);
}
const config = readJson(resolve(dirname(pointerPath), pointer.configPath));

const problems = [];

// A plain build leaves targetEnvironment null; CLOUDFLARE_ENV=staging sets it.
const built = config.targetEnvironment ?? "production";
if (built !== target) {
  problems.push(`expected a ${target} build, found Worker "${config.name}" built for ${built}.`);
}

if (config.name !== workerNames[target]) {
  problems.push(`expected Worker "${workerNames[target]}" for ${target}, found "${config.name}".`);
}

if (target === "staging" && config.routes?.length) {
  const patterns = config.routes.map((route) => route.pattern ?? route).join(", ");
  problems.push(
    `the staging build has routes and would take ${patterns} from the production Worker. Set "routes": [] in env.staging.`,
  );
}

const convexUrl = process.env.VITE_CONVEX_URL;
const workerUrl = config.vars?.VITE_CONVEX_URL;
if (!convexUrl) {
  problems.push(
    "VITE_CONVEX_URL is not set. Run this inside `convex deploy --cmd`, which sets it.",
  );
} else if (workerUrl !== convexUrl) {
  problems.push(
    `the Convex credentials select ${convexUrl}, but Worker "${config.name}" expects ${workerUrl ?? "no Convex URL"}.`,
  );
}

// The client bundle inlines the build's key while the Worker reads its var at
// runtime. loadEnv resolves it as `vite build` did: process.env first, then
// .env.local and the other .env files. Unset means a build without Clerk,
// which stays allowed.
const clerkKey = loadEnv("production", root, "VITE_").VITE_CLERK_PUBLISHABLE_KEY;
const workerClerkKey = config.vars?.VITE_CLERK_PUBLISHABLE_KEY;
if (clerkKey && clerkKey !== workerClerkKey) {
  problems.push(
    `the build's VITE_CLERK_PUBLISHABLE_KEY (${clerkKey}) differs from Worker "${config.name}" (${workerClerkKey ?? "none"}).`,
  );
}

if (problems.length > 0) fail(problems);

console.log(`check-deploy-target: ${target} Worker "${config.name}" uses Convex ${convexUrl}.`);
