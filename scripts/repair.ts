// Runner for the one-time catalog repair (convex/repair.ts). Reads
// repair-plan.json (built by /tmp/mangadb-audit/plan/build_plan.py) and feeds
// it to `npx convex run repair:runBatch` step by step, batch by batch.
// Dry-run is the default; nothing writes without --apply.
//
//   node scripts/repair.ts metrics [label]
//   node scripts/repair.ts run --stage 3 [--step 3a] [--apply] [--actor ari]
//   node scripts/repair.ts rebuild            # seriesBrowse:rebuild
//
// Options: --plan <repair-plan.json>  --out <dir for run reports; default runs/ next to the plan>
//          --deployment <name|prod>   passed to `convex run`; anything other
//                                     than the local deployment needs --yes
//          --force                    run stage 4 without complete research
//
// Each run writes <out>/<stamp>-stage<N>-<dry|apply>.json with every
// non-applied outcome, and prints per-step counts.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Entry = { key: string; reason: string } & Record<string, unknown>;
type Step = { step: string; title: string; kind: string; batchSize: number; entries: Entry[] };
type Stage = { stage: number; name: string; requiresPackagingResearch?: boolean; steps: Step[] };
type Plan = { inputs: { packagingResearchComplete: boolean }; stages: Stage[] };
type Outcome = { key: string; status: string; reason?: string; notes?: string[] };

const argv = process.argv.slice(2);
const command = argv[0];
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};

const planPath = option("plan", "/tmp/mangadb-audit/plan/repair-plan.json");
const outDir = option("out", join(dirname(planPath), "runs"));
const deployment = option("deployment", "");
const actor = option("actor", "ari");
const apply = flag("apply");

/** Refuse non-local targets unless the operator says --yes explicitly. */
function targetFlags(): string[] {
  const envTarget = process.env.CONVEX_DEPLOYMENT ?? readEnvLocal();
  const target = deployment || envTarget;
  const local = deployment === "" ? envTarget.startsWith("local:") : deployment === "local";
  if (!local && !flag("yes")) {
    throw new Error(`Refusing to target "${target}" without --yes (the sandbox is the local deployment).`);
  }
  console.error(`[repair] target: ${target || "(default dev deployment)"}`);
  return deployment ? ["--deployment", deployment] : [];
}

function readEnvLocal(): string {
  try {
    const match = /^CONVEX_DEPLOYMENT=(\S+)/m.exec(readFileSync(".env.local", "utf8"));
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

const TARGET = command === undefined ? [] : targetFlags();

function convexRun(fn: string, args: unknown): string {
  return execFileSync(
    "npx",
    ["convex", "run", "--codegen", "disable", "--typecheck", "disable", ...TARGET, fn, JSON.stringify(args)],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] },
  );
}

/** Largest JSON argument one `convex run` call gets (Linux caps one argv string at 128 KiB). */
const MAX_ARG_BYTES = 100_000;

function batches(entries: Entry[], size: number): Entry[][] {
  const out: Entry[][] = [];
  let current: Entry[] = [];
  let bytes = 0;
  for (const entry of entries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry));
    if (current.length > 0 && (current.length >= size || bytes + entryBytes > MAX_ARG_BYTES)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(entry);
    bytes += entryBytes;
  }
  if (current.length > 0) out.push(current);
  return out;
}

/** Run one batch; a batch that blows a transaction limit is halved and retried. */
function runBatch(kind: string, entries: Entry[], dryRun: boolean): Outcome[] {
  const withKind = entries.map((entry) => ({ kind, ...entry }));
  try {
    return JSON.parse(convexRun("repair:runBatch", { entries: withKind, dryRun, actor })) as Outcome[];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (entries.length > 1) {
      const half = Math.ceil(entries.length / 2);
      console.error(`[repair] batch of ${entries.length} failed (${message.split("\n").find((l) => /error/i.test(l)) ?? "error"}); halving`);
      return [...runBatch(kind, entries.slice(0, half), dryRun), ...runBatch(kind, entries.slice(half), dryRun)];
    }
    return [{ key: entries[0]?.key ?? "?", status: "error", reason: message.slice(0, 800) }];
  }
}

function runStep(step: Step, dryRun: boolean): Outcome[] {
  const outcomes: Outcome[] = [];
  const all = batches(step.entries, step.batchSize);
  for (const [i, batch] of all.entries()) {
    let results = runBatch(step.kind, batch, dryRun);
    // A chunked publisher merge reports "partial" until its last chunk.
    for (let round = 0; !dryRun && round < 100; round++) {
      const partial = new Set(results.filter((o) => o.status === "partial").map((o) => o.key));
      if (partial.size === 0) break;
      const again = runBatch(step.kind, batch.filter((e) => partial.has(e.key)), dryRun);
      results = [...results.filter((o) => !partial.has(o.key)), ...again];
    }
    outcomes.push(...results);
    if (all.length > 5 && (i + 1) % 10 === 0) console.error(`[repair] ${step.step}: ${i + 1}/${all.length} batches`);
  }
  return outcomes;
}

function tally(outcomes: Outcome[]) {
  const counts: Record<string, number> = {};
  const reasons: Record<string, number> = {};
  for (const o of outcomes) {
    counts[o.status] = (counts[o.status] ?? 0) + 1;
    if (o.status === "skipped" || o.status === "error" || o.status === "deferred") {
      const reason = `${o.status}: ${(o.reason ?? "").replace(/[a-z0-9]{32}/g, "<id>").replace(/\d+/g, "N").slice(0, 120)}`;
      reasons[reason] = (reasons[reason] ?? 0) + 1;
    }
  }
  return { counts, reasons };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function runStage(plan: Plan, stageNo: number, onlyStep: string | null) {
  const stage = plan.stages.find((s) => s.stage === stageNo);
  if (!stage) throw new Error(`No stage ${stageNo} in the plan.`);
  if (stage.requiresPackagingResearch && !plan.inputs.packagingResearchComplete && !flag("force")) {
    throw new Error("Stage 4 needs the packaging research shards; rebuild the plan once they land (or --force).");
  }
  const mode = apply ? "apply" : "dry";
  const report: Record<string, { counts: Record<string, number>; reasons: Record<string, number>; outcomes: Outcome[] }> = {};
  for (const step of stage.steps) {
    if (onlyStep && step.step !== onlyStep) continue;
    const started = Date.now();
    const outcomes = runStep(step, !apply);
    const { counts, reasons } = tally(outcomes);
    report[step.step] = { counts, reasons, outcomes: outcomes.filter((o) => (o.status !== "applied" && o.status !== "alreadyApplied") || o.notes) };
    console.log(`${step.step} ${step.kind} (${step.entries.length}) ${mode} ${((Date.now() - started) / 1000).toFixed(0)}s: ${JSON.stringify(counts)}`);
    for (const [reason, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
      console.log(`    ${n} × ${reason}`);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `${stamp()}-stage${stageNo}${onlyStep ? `-${onlyStep}` : ""}-${mode}.json`);
  writeFileSync(file, JSON.stringify(report, null, 1));
  console.log(`report: ${file}`);
}

switch (command) {
  case "metrics": {
    const result = convexRun("repair:metrics", {});
    mkdirSync(outDir, { recursive: true });
    const file = join(outDir, `metrics-${argv[1] && !argv[1].startsWith("--") ? argv[1] : stamp()}.json`);
    writeFileSync(file, result);
    console.log(result.trim());
    console.log(`saved: ${file}`);
    break;
  }
  case "run": {
    const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
    const stepOnly = option("step", "");
    runStage(plan, Number(option("stage", "0")), stepOnly || null);
    break;
  }
  case "rebuild":
    console.log(convexRun("seriesBrowse:rebuild", {}).trim());
    break;
  default:
    console.log("usage: node scripts/repair.ts metrics [label] | run --stage N [--step ID] [--apply] | rebuild");
}
