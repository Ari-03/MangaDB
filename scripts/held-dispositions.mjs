// Initialize an offline ledger from the reviewed report. It never executes repairs.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [input, output] = process.argv.slice(2);
if (!input || !output)
  throw new Error("Usage: node scripts/held-dispositions.mjs report-data.json new-ledger.json");
const bytes = await readFile(input);
const report = JSON.parse(bytes.toString("utf8"));
const seen = new Set();
const observations = report.observations.map((observation) => {
  if (seen.has(observation.observationId))
    throw new Error(`Duplicate observation ${observation.observationId}`);
  seen.add(observation.observationId);
  return {
    ...observation,
    state: "pending",
    blockingFact: observation.nextAction,
    nextQuery: {
      function: "heldBooks:previewInternal",
      args: { observationId: observation.observationId },
    },
    // An operator records actual preview, reviewed operations and their results here.
    operations: [],
    audits: [],
  };
});
const groupsSeen = new Set();
const observationsById = new Map(observations.map((row) => [row.observationId, row]));
const grouped = new Set();
const groups = report.groups.map((group) => {
  if (groupsSeen.has(group.bookKey)) throw new Error(`Duplicate group ${group.bookKey}`);
  groupsSeen.add(group.bookKey);
  const ids = group.observations.map((row) => {
    const observation = observationsById.get(row.observationId);
    if (!observation || observation.bookKey !== group.bookKey || grouped.has(row.observationId))
      throw new Error(`Invalid group membership ${row.observationId}`);
    grouped.add(row.observationId);
    return row.observationId;
  });
  return { ...group, state: "pending", observationIds: ids, terminalDisposition: null };
});
if (
  grouped.size !== seen.size ||
  groups.length !== report.meta.counts.groups ||
  observations.length !== report.meta.counts.observations
)
  throw new Error("Incomplete inventory; no disposition ledger written.");
await writeFile(
  output,
  `${JSON.stringify(
    {
      meta: {
        ...report.meta,
        inputSha256: createHash("sha256").update(bytes).digest("hex"),
        kind: "offline_disposition_ledger",
        executable: false,
        countsAreSnapshotFacts: true,
        eligibilityEstimate: null,
      },
      categoryActions: report.categoryActions,
      groups,
      observations,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    groups: groups.length,
    observations: observations.length,
    pendingGroups: groups.length,
    executedOperations: 0,
  }),
);
